package main

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 120 * time.Second
	pingPeriod     = 25 * time.Second
	maxMessageSize = 128 * 1024 // 128KB（履歴データ等の増大に対応）
)

// ────────────────────────────────────────────────────────────
// 常数
// ────────────────────────────────────────────────────────────
const masterPasscode = "R4pN7"
const mentorPasscode = "A7kP9"
const bothPasscode   = "R4pN7A7kP9" // 管理者＋メンター同時付与

// Client はWebSocket接続ごとの状態を保持する
type Client struct {
	hub          *Hub
	conn         *websocket.Conn
	send         chan []byte
	username     string
	mode         string // "chat" | "interview" | "gd" | "secret"
	role         string // "interviewer" | "interviewee" | "observer" | "moderator" | "secretary" | "presenter" | "participant"
	passcode     string // ルームを分けるための合言葉
	forceLeave   bool   // 明示的なログアウト（離席猶予なし）
	isMobile     bool   // デバイス種別
	isRoleUpdate bool   // 役割変更のみの更新かどうか
	isAdmin      bool   // 管理者かどうか
	isMentor     bool   // メンターかどうか
	isHidden     bool   // ゴーストモードかどうか
}

// readPump はクライアントからのメッセージを読み取りHubへ渡す
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// joinメッセージが来なければ5秒でタイムアウト切断
	joinDeadline := time.Now().Add(5 * time.Second)
	joined := false

	for {
		// joinが完了していない場合はDeadlineを短く保つ
		if !joined {
			c.conn.SetReadDeadline(joinDeadline)
		}

		_, rawMsg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("readPump error: %v", err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			log.Printf("JSON parse error: %v", err)
			continue
		}

		// joinメッセージ処理
		if msg.Type == "join" {
			trimmedName := strings.TrimSpace(msg.Username)
			if trimmedName == "" {
				log.Printf("名前不正拒否: 空要素またはスペースのみ")
				errData, _ := json.Marshal(Message{
					Type:    "error",
					Content: "その名前は使用できません。適切な名前を入力してください。",
				})
				c.send <- errData
				time.Sleep(500 * time.Millisecond)
				return
			}

			// 名前重複チェック（オンライン中および離席猶予中も対象）
			h := c.hub
			h.mu.RLock()
			_, isOnline := h.usernames[trimmedName]
			_, isOffline := h.offlineUsers[trimmedName]
			h.mu.RUnlock()

			if !msg.IsAutoLogin && (isOnline || isOffline) {
				log.Printf("名前重複拒否: %s (online=%v, offline=%v)", trimmedName, isOnline, isOffline)
				errData, _ := json.Marshal(Message{
					Type:    "error",
					Content: "同じ名前が存在する為入室出来ません。",
				})
				c.send <- errData
				time.Sleep(500 * time.Millisecond)
				return
			}

			isAdmin := false
			isMentor := false

			// AdminPassフィールドから権限判定（完全一致）
			switch strings.TrimSpace(msg.AdminPass) {
			case bothPasscode:
				isAdmin = true
				isMentor = true
			case masterPasscode:
				isAdmin = true
			case mentorPasscode:
				isMentor = true
			}

			// 部屋コードの準備（空白を除去してクリーンに）
			msg.Passcode = strings.ReplaceAll(strings.TrimSpace(msg.Passcode), " ", "")
			msg.Passcode = strings.ReplaceAll(msg.Passcode, "　", "")

			log.Printf("権限判定: adminPass=%s, isAdmin=%v, isMentor=%v, passcode=%s", msg.AdminPass, isAdmin, isMentor, msg.Passcode)

			c.username = trimmedName
			c.mode = msg.Mode
			c.role = msg.Role
			c.isMobile = msg.IsMobile
			c.isAdmin = isAdmin
			c.isMentor = isMentor
			c.isHidden = msg.IsHidden 
			// 入室時のモードに合わせて合言葉を正規化（二重付与防止）
			c.passcode = buildEffectiveRoom(c.mode, msg.Passcode)

			// ユーザー登録（DBへ）
			saveUserRegister(c.username)
			log.Printf("ユーザー登録: %s (mode=%s, passcode=%s)", c.username, c.mode, c.passcode)

			// 1. まず管理者権限情報 (Welcome) を送る（これでしクライアント側の state.isAdmin が確定する）
			welcomePass := msg.Passcode
			welcome, _ := json.Marshal(Message{
				Type:     "welcome",
				IsAdmin:  c.isAdmin,
				IsMentor: c.isMentor,
				IsHidden: c.isHidden,
				Mode:     c.mode, // 追加: 初期UI同期用
				Role:     c.role, // 追加: 初期UI同期用
				Passcode: welcomePass, 
				Content:  "Welcome to GoChat",
			})
			c.send <- welcome

			// 2. 次に過去の履歴を送る
			if d, err := json.Marshal(Message{Type: "history_sep", Content: "start"}); err == nil {
				c.send <- d
			}
			
			recentMsgs := getRecentMessages(200, c.passcode)
			for i, hMsg := range recentMsgs {
				// 面接官専用は面接官（または管理者）のみに送る
				if hMsg.Type == "interviewer_chat" && c.role != "interviewer" && !c.isAdmin {
					continue
				}
				// 履歴メッセージとして送信
				if d, err := json.Marshal(hMsg); err == nil {
					c.send <- d
				}
				
				// 10件ごとに少し待機
				if i > 0 && i%10 == 0 {
					time.Sleep(1 * time.Millisecond)
				}
			}
			
			if len(recentMsgs) > 0 {
				if d, err := json.Marshal(Message{Type: "history_sep", Content: "end"}); err == nil {
					c.send <- d
				}
			}

			// 3. 最新のGD共有メモを送信
			gdNote := getGDNote(c.passcode)
			if d, err := json.Marshal(Message{Type: "note_update", Note: gdNote}); err == nil {
				c.send <- d
			}

			// ユーザー登録と入室通知
			joined = true
			c.conn.SetReadDeadline(time.Now().Add(pongWait))
			c.hub.userJoined <- c
			continue
		}

		// pingメッセージ処理 (Heartbeat)
		if msg.Type == "ping" {
			pong, _ := json.Marshal(Message{Type: "pong"})
			c.send <- pong
			continue
		}

		// mode_changeメッセージ処理: サーバー側のmode/role/passcodeを更新
		if msg.Type == "mode_change" {
			oldMode := c.mode
			oldRole := c.role
			oldPass := c.passcode
			wasAdmin := c.isAdmin
			wasMentor := c.isMentor

			// 入力された文字列を「正」として権限をゼロから再評価する
			newIsAdmin := false
			newIsMentor := false

			// AdminPassフィールドから権限判定（完全一致）
			switch strings.TrimSpace(msg.AdminPass) {
			case bothPasscode:
				newIsAdmin = true
				newIsMentor = true
			case masterPasscode:
				newIsAdmin = true
			case mentorPasscode:
				newIsMentor = true
			}

			// 部屋コードの準備(空白を除去してクリーンに）
			effectivePass := strings.ReplaceAll(strings.TrimSpace(msg.Passcode), " ", "")
			effectivePass = strings.ReplaceAll(effectivePass, "　", "")

			// 全ての状態を更新
			c.isAdmin = newIsAdmin
			c.isMentor = newIsMentor
			c.mode = msg.Mode
			c.role = msg.Role
			c.passcode = buildEffectiveRoom(msg.Mode, effectivePass)

			// 常にwelcomeメッセージを送ってクライアントと同期（役割変更などを確実に反映させる）
			welcomePass := effectivePass
			if c.isAdmin || c.isMentor {
				welcomePass = effectivePass // 新方式ではpasscodeに権限コードを混ぜない
			}
			welcome, _ := json.Marshal(Message{
				Type:     "welcome",
				IsAdmin:  c.isAdmin,
				IsMentor: c.isMentor,
				IsHidden: c.isHidden,
				Mode:     c.mode,
				Role:     c.role,
				Passcode: welcomePass,
				Content:  "設定を更新しました",
			})
			c.send <- welcome
			log.Printf("モード変更: %s -> mode=%s, role=%s, effectivePasscode=%s, isAdmin=%v, isMentor=%v", c.username, c.mode, c.role, c.passcode, c.isAdmin, c.isMentor)

			// 管理者リストを即座に更新（モード切り替えタグを反映させるため）
			c.hub.broadcastAdminRoomsList()
			
			// ユーザーリストも即座に更新（バッジ等の変更を全員に反映させるため）
			c.hub.broadcastUserList()

			// 管理者に昇格した場合は即座に部屋リストを要求させる
			if !wasAdmin && c.isAdmin {
				c.hub.adminAction <- adminActionReq{client: c, msg: Message{Type: "admin_get_rooms"}}
			}

			// 部屋や権限が変わった場合（モードや合言葉・管理者・メンターの変更）新しい履歴を送信
			if oldMode != c.mode || oldPass != c.passcode || wasAdmin != c.isAdmin || wasMentor != c.isMentor {
				c.isRoleUpdate = false
				// 元の部屋に退出メッセージを送信 (管理者の場合は抑制)
				if oldPass != c.passcode && !c.isAdmin {
					leaveMsg := Message{
						Type:      "system",
						Content:   c.username + " さんが退出しました",
						Timestamp: nowJST(),
						Passcode:  oldPass,
						NoHistory: true,
					}
					if leaveData, err := json.Marshal(leaveMsg); err == nil {
						c.hub.broadcast <- BroadcastEntry{data: leaveData, msgType: "system"}
					}
				}

				// 履歴がない場合でも画面をクリアするために start を必ず送信
				if d, err := json.Marshal(Message{Type: "history_sep", Content: "start"}); err == nil {
					c.send <- d
				}

				recentMsgs := getRecentMessages(200, c.passcode)
				for _, hMsg := range recentMsgs {
					// 面接官専用チャットのフィルタリングを管理者のみバイパス
					if hMsg.Type == "interviewer_chat" && c.role != "interviewer" && !c.isAdmin {
						continue
					}
					if d, err := json.Marshal(hMsg); err == nil {
						c.send <- d
					}
				}
				
				if len(recentMsgs) > 0 {
					if d, err := json.Marshal(Message{Type: "history_sep", Content: "end"}); err == nil {
						c.send <- d
					}
				}
				// 部屋が変わったので、新しい部屋の共有メモ（GDNote）も取得して送信する
				gdNote := getGDNote(c.passcode)
				if d, err := json.Marshal(Message{Type: "note_update", Note: gdNote}); err == nil {
					c.send <- d
				}
			} else {
				// 部屋は同じで役割等だけ変更された場合
				c.isRoleUpdate = true
				if oldRole != c.role {
					roleMsg := Message{
						Type:      "system",
						Content:   c.username + " さんが役割を変更しました",
						Timestamp: nowJST(),
						Passcode:  c.passcode,
						NoHistory: true,
					}
					if roleData, err := json.Marshal(roleMsg); err == nil {
						c.hub.broadcast <- BroadcastEntry{data: roleData, msgType: "system"}
					}
				}
			}

			// モードや役割が変更されたのでユーザーリストと部屋リストを再配信
			c.hub.userJoined <- c
			c.hub.broadcastAdminRoomsList()
			continue
		}

		// status_changeメッセージ処理: バックグラウンド/フォアグラウンドの状態変更
		if msg.Type == "status_change" {
			c.hub.statusChange <- statusChangeRequest{client: c, isOnline: msg.IsOnline}
			continue
		}

		// logoutメッセージ処理
		if msg.Type == "logout" {
			c.forceLeave = true
			log.Printf("ログアウト要請: %s", c.username)
			return // 切断へ
		}

		// deleteメッセージ処理
		if msg.Type == "delete" {
			if msg.ID != "" {
				c.hub.deleteReq <- deleteRequest{id: msg.ID, requestedBy: c.username, passcode: c.passcode}
			}
			continue
		}

		// clear_noteメッセージ処理
		if msg.Type == "clear_note" {
			msg.Passcode = c.passcode
			data, _ := json.Marshal(msg)
			c.hub.broadcast <- BroadcastEntry{data: data, msgType: msg.Type}
			continue
		}

		// 管理者アクションのハンドリング部
		if msg.Type == "kick" || msg.Type == "rename_user" || msg.Type == "ghost_toggle" || 
		   msg.Type == "room_reset" || msg.Type == "admin_get_rooms" || msg.Type == "admin_delete_room" ||
		   msg.Type == "admin_broadcast" || msg.Type == "admin_get_peek_history" || msg.Type == "admin_join_room" {
			if c.isAdmin || c.isMentor {
				c.hub.adminAction <- adminActionReq{client: c, msg: msg}
			}
			continue
		}

		// dmメッセージ処理: 全体履歴に保存し当事者のみに配信
		if msg.Type == "dm" {
			if msg.To != "" && msg.To != c.username {
				msg.Username = c.username
				msg.Timestamp = nowJST()
				msg.Passcode = c.passcode // DMにも合言葉を付与（合言葉なしDMなら空）
				msg.IsAdmin = c.isAdmin
				msg.IsMentor = c.isMentor
				msg.ID = uuid.New().String() // DMも取り消しできるようにID付与
				data, _ := json.Marshal(msg)
				c.hub.sendToUser(msg.To, data)   // 受信者へ
				c.hub.sendToUser(msg.Username, data) // 自分へ（履歴用）
			}
			continue
		}

		// 通常メッセージ: サーバー側でusername/role/timestamp/IDを付与
		msg.Username = c.username
		msg.Role = c.role
		msg.Mode = c.mode
		msg.Passcode = c.passcode
		msg.Timestamp = nowJST()
		msg.IsAdmin = c.isAdmin // 管理者情報を付与
		msg.IsMentor = c.isMentor // メンター情報を付与
		// text/image/interviewer_chatにはUUIDを付与（取り消し機能のため）
		if msg.Type != "note_update" && msg.ID == "" {
			msg.ID = uuid.New().String()
		}
		
		data, _ := json.Marshal(msg)
		c.hub.broadcast <- BroadcastEntry{data: data, msgType: msg.Type}
	}
}

// writePump はsendチャネルのメッセージをクライアントへ送信する
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
