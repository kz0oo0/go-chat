package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxHistory はサーバーで保持するメッセージ履歴の最大件数
const maxHistory = 200

// BroadcastEntry はブロードキャスト対象のメッセージと種別を保持する
type BroadcastEntry struct {
	data    []byte
	msgType string
}

// deleteRequest はメッセージ取り消しリクエスト
type deleteRequest struct {
	id          string
	requestedBy string
	passcode    string
}

// offlineUser は一時的に切断されたユーザーの情報
type offlineUser struct {
	Username string
	Role     string
	Mode     string
	Passcode string
	LastSeen time.Time
	IsAdmin  bool
	IsMentor bool
	IsHidden bool
}

// statusChangeRequest はステータス変更リクエスト
type statusChangeRequest struct {
	client   *Client
	isOnline bool
}

// adminActionReq は管理者操作のリクエスト
type adminActionReq struct {
	client *Client
	msg    Message
}

// Hub は接続中のクライアントを管理し、メッセージをブロードキャストする
type Hub struct {
	adminAction  chan adminActionReq
	clients      map[*Client]bool
	broadcast    chan BroadcastEntry
	register     chan *Client
	unregister   chan *Client
	deleteReq    chan deleteRequest
	clearNoteReq chan bool
	userJoined    chan *Client       // username確定後に送信
	usernames     map[string]*Client // username → Client
	offlineUsers  map[string]*offlineUser // username → offlineUser
	statusChange  chan statusChangeRequest // ステータス変更通知
	lastClearTime  map[string]time.Time
	lastActiveMode map[string]string // 生の合言葉 → 最新アクティブモード
	mu             sync.RWMutex // usernames, offlineUsers保護用
}

func newHub() *Hub {
	return &Hub{
		adminAction:  make(chan adminActionReq, 64),
		broadcast:    make(chan BroadcastEntry, 256),
		register:     make(chan *Client, 128),
		unregister:   make(chan *Client, 128),
		deleteReq:    make(chan deleteRequest, 32),
		clearNoteReq: make(chan bool),
		userJoined:   make(chan *Client, 64),
		usernames:    make(map[string]*Client),
		offlineUsers: make(map[string]*offlineUser),
		statusChange:  make(chan statusChangeRequest, 64),
		clients:      make(map[*Client]bool),
		lastClearTime:  make(map[string]time.Time),
		lastActiveMode: make(map[string]string),
	}
}

func (h *Hub) run() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// 24時間ごとのパトロール用（DBが空の部屋を自動削除する）
	cleanupTicker := time.NewTicker(24 * time.Hour)
	defer cleanupTicker.Stop()

	for {
		select {
		case <-ticker.C:
			// 離席猶予（5分）が過ぎたユーザーを削除
			h.mu.Lock()
			now := time.Now()
			for name, offUser := range h.offlineUsers {
				if now.Sub(offUser.LastSeen) > 5*time.Minute {
					delete(h.offlineUsers, name)
					log.Printf("離席猶予終了: %s", name)

					// 隠密中または管理者の場合は退出通知を出さない
					if !offUser.IsHidden && !offUser.IsAdmin {
						msg := Message{
							Type:      "system",
							Content:   name + " さんが退出しました",
							Timestamp: nowJST(),
							Passcode:  offUser.Passcode,
						}
						data, _ := json.Marshal(msg)
						h.mu.Unlock() // broadcastUserList内でRLockするため一旦外す
						h.broadcastRaw(data, "system") 
						h.broadcastUserList()

						// 離席猶予が切れて完全にいなくなったので、その部屋が空なら削除
						_, rawPass := splitEffectiveRoom(offUser.Passcode)
						if rawPass != "" {
							h.CheckEmptyRoom(rawPass)
						}

						h.mu.Lock()
					} else {
						h.mu.Unlock()
						h.broadcastUserList()

						// 隠密/管理者でも同様に空室チェック
						_, rawPass := splitEffectiveRoom(offUser.Passcode)
						if rawPass != "" {
							h.CheckEmptyRoom(rawPass)
						}

						h.mu.Lock()
					}
				}
			}
			h.mu.Unlock()

		case <-cleanupTicker.C:
			// 24時間おきに全データをパトロールし、空の部屋があれば削除する
			passcodes := getAllPasscodesWithData()
			for _, pc := range passcodes {
				_, rawPass := splitEffectiveRoom(pc)
				if rawPass != "" {
					// CheckEmptyRoom は、参加者がおらずDBが実質空の場合のみ削除を実行する
					h.CheckEmptyRoom(rawPass)
				}
			}
			// 念のため管理者リストを更新
			h.broadcastAdminRoomsList()

		case client := <-h.register:
			h.clients[client] = true
			log.Printf("接続: %s (mode=%s, role=%s)", client.username, client.mode, client.role)

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				// usernamesからも削除（同一clientの場合のみ）
				h.mu.Lock()
				if stored, ok := h.usernames[client.username]; ok && stored == client {
					delete(h.usernames, client.username)
					
					// 離席猶予リストに追加（usernameがある場合のみ、かつ強制退出でない場合）
					if client.username != "" {
						if client.forceLeave {
							// 明示的ログアウト時（隠密中または管理者の場合は通知しない）
							if !client.isHidden && !client.isAdmin {
								msg := Message{
									Type:      "system",
									Content:   client.username + " さんが退出しました",
									Timestamp: nowJST(),
									Passcode:  client.passcode,
								}
								data, _ := json.Marshal(msg)
								h.mu.Unlock()
								h.broadcastRaw(data, "system")
								h.broadcastUserList()
								h.mu.Lock()
							} else {
								h.mu.Unlock()
								h.broadcastUserList()
								h.mu.Lock()
							}
							log.Printf("明示的ログアウト: %s", client.username)
						} else if client.isMobile {
							// スマホのみ猶予開始
							h.offlineUsers[client.username] = &offlineUser{
								Username: client.username,
								Role:     client.role,
								Mode:     client.mode,
								Passcode: client.passcode,
								LastSeen: time.Now(),
								IsAdmin:  client.isAdmin,
								IsMentor: client.isMentor,
								IsHidden: client.isHidden,
							}
							log.Printf("離席猶予開始: %s (スマホ: 5分間保持)", client.username)
						} else {
							// PCは即座にリストから削除（猶予なし）
							log.Printf("即時退出: %s (PC)", client.username)
						}
					}
				}
				h.mu.Unlock()
				close(client.send)
				log.Printf("切断: %s", client.username)
				
				// ユーザーリストと管理者リストを即座に更新
				h.broadcastUserList()
				h.broadcastAdminRoomsList()

				// 部屋が「空（参加者0かつデータなし）」になった場合の自動削除
				_, rawPass := splitEffectiveRoom(client.passcode)
				if rawPass != "" {
					h.CheckEmptyRoom(rawPass)
				}

				h.broadcastAdminRoomsList()
			}

		case req := <-h.statusChange:
			// WebSocketは切れていないが、バックグラウンド移動等により離席/復帰としてマーク
			c := req.client
			if c.username == "" {
				continue
			}

			h.mu.Lock()
			if !req.isOnline {
				// 離席マーク: usernamesからは削除せずにオフラインリストへ追加（または更新）
				// 注意: ここでusernamesから消すと、broadcastUserListが送れなくなるため
				// usernamesには残しつつ、放送時に offlineUsers を優先評価する。
				h.offlineUsers[c.username] = &offlineUser{
					Username: c.username,
					Role:     c.role,
					Mode:     c.mode,
					Passcode: c.passcode,
					LastSeen: time.Now(),
					IsAdmin:  c.isAdmin,
					IsMentor: c.isMentor,
					IsHidden: c.isHidden,
				}
				log.Printf("ステータス変更: %s -> 離席", c.username)
			} else {
				// 復帰マーク
				delete(h.offlineUsers, c.username)
				log.Printf("ステータス変更: %s -> 復帰", c.username)
			}
			h.mu.Unlock()
			h.broadcastUserList()
			h.broadcastAdminRoomsList()

		case entry := <-h.broadcast:
			// NoHistoryやDMの宛先を評価するため先にUnmarshal
			var m Message
			json.Unmarshal(entry.data, &m)
			isDm := entry.msgType == "dm"

			// 履歴へ保存（NoHistoryがtrueの場合は保存しない）
			if !m.NoHistory {
				switch entry.msgType {
				case "text", "image", "system", "interviewer_chat", "dm":
					saveMessage(&m)
				case "note_update":
					// 一括削除後2秒間は再浮上を防ぐためnote_updateを無視する
					if time.Since(h.lastClearTime[m.Passcode]) > 2*time.Second {
						if m.Note != nil {
							saveGDNote(m.Note, m.Passcode)
							h.broadcastAdminRoomsList()
						}
					} else {
						continue
					}
				case "clear_note":
					h.lastClearTime[m.Passcode] = time.Now()
					clearGDNote(m.Passcode)
					_, rawClear := splitEffectiveRoom(m.Passcode)
					h.CheckEmptyRoom(rawClear)
					h.broadcastAdminRoomsList()
				}
				
				// メッセージのモードを「最新のアクティブモード」として記録（管理パネルのタグ用）
				if entry.msgType != "system" && entry.msgType != "user_list" && entry.msgType != "admin_rooms_list" {
					_, rawPass := splitEffectiveRoom(m.Passcode)
					// メインルーム (rawPass == "") も含めて記録する
					h.mu.Lock()
					h.lastActiveMode[rawPass] = m.Mode
					h.mu.Unlock()
				}
			}

			for client := range h.clients {
				// 面接官専用チャットは面接官（または管理者）のみへ配信
				if (entry.msgType == "interviewer_chat" && client.role != "interviewer" && !client.isAdmin) {
					continue
				}
				// DMの場合は、送信者と受信者のみへ配信
				if isDm && client.username != m.Username && client.username != m.To {
					continue
				}

				// 合言葉によるフィルタリング
				if m.Passcode != client.passcode && entry.msgType != "user_list" && entry.msgType != "admin_rooms_list" {
					continue
				}

				select {
				case client.send <- entry.data:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			// 最新のアクティブモードを記録 (システム型以外の場合)
			if entry.msgType != "system" && entry.msgType != "user_list" && entry.msgType != "admin_rooms_list" {
				_, raw := splitEffectiveRoom(m.Passcode)
				if raw != "" {
					h.mu.Lock()
					h.lastActiveMode[raw] = m.Mode
					h.mu.Unlock()
				}
			}
			h.broadcastAdminRoomsList()

		case req := <-h.deleteReq:
			// DBを論理削除
			markMessageDeleted(req.id)

			delMsg := Message{Type: "delete", ID: req.id, Passcode: req.passcode}
			data, _ := json.Marshal(delMsg)
			
			for client := range h.clients {
				if client.passcode == req.passcode {
					select {
					case client.send <- data:
					default:
						close(client.send)
						delete(h.clients, client)
					}
				}
			}
			log.Printf("取り消し: id=%s by=%s", req.id, req.requestedBy)
			
			// 取り消しによって部屋が完全に空になった場合に備えてチェック
			_, rawDel := splitEffectiveRoom(req.passcode)
			h.CheckEmptyRoom(rawDel)
			h.broadcastAdminRoomsList()

		case act := <-h.adminAction:
			handleAdminAction(h, act.client, act.msg)

		case client := <-h.userJoined:
			if client.username == "" {
				continue
			}
			// 名前が確定したタイミングで、離席猶予リストにあれば削除（復帰扱い）
			h.mu.Lock()
			_, resumed := h.offlineUsers[client.username]
			// 既存のオフライン記録があれば引き継ぎ（ただし、現在のisAdmin設定が優先されるようにマージ）
			if off, ok := h.offlineUsers[client.username]; ok {
				if !client.isAdmin {
					client.isAdmin = off.IsAdmin
				}
				if !client.isMentor {
					client.isMentor = off.IsMentor
				}
				if !client.isHidden {
					client.isHidden = off.IsHidden
				}
				delete(h.offlineUsers, client.username) // 復帰したらオフラインリストから削除
			}
			h.usernames[client.username] = client
			h.mu.Unlock()
			
			// 合言葉（モード含む）が変わったタイミングでも最新アクティブモードとして記録
			if client.username != "" {
				_, rawPass := splitEffectiveRoom(client.passcode)
				h.mu.Lock()
				h.lastActiveMode[rawPass] = client.mode
				h.mu.Unlock()
			}

			if !resumed && !client.isRoleUpdate {
				// 新規入室の場合のみ通知（隠密中または管理者の場合は通知しない）
				isStealth := client.isHidden || client.isAdmin || client.username == "admin"
				if !isStealth {
					msg := Message{
						Type:      "system",
						Content:   client.username + " さんが入室しました",
						Timestamp: nowJST(),
						Passcode:  client.passcode,
						NoHistory: true,
					}
					data, _ := json.Marshal(msg)
					// broadcastRaw ではなく broadcast チャンネル経由でパスコードフィルタリングを適用
					h.broadcast <- BroadcastEntry{data: data, msgType: "system"}
					log.Printf("ユーザー登録(新規): %s", client.username)
				} else {
					log.Printf("ユーザー登録(隠密/管理者): %s", client.username)
				}
			} else if client.isRoleUpdate {
				log.Printf("ユーザー設定変更(役割): %s", client.username)
			} else {
				log.Printf("ユーザー復帰: %s", client.username)
			}
			h.broadcastUserList()
			h.broadcastAdminRoomsList()
		}
	}
}

// broadcastRaw は全クライアントへデータを送信する（内部用）
func (h *Hub) broadcastRaw(data []byte, msgType string) {
	h.mu.RLock()
	total := len(h.clients)
	sent := 0
	for client := range h.clients {
		select {
		case client.send <- data:
			sent++
		default:
			close(client.send)
			delete(h.clients, client)
		}
	}
	h.mu.RUnlock()
	log.Printf("一斉配信(%s): 接続者=%d, 送信成功=%d", msgType, total, sent)
}

// broadcastUserList はオンラインユーザーリストを合言葉（Passcode）ごとにフィルタリングして配信する
func (h *Hub) broadcastUserList() {
	// クライアントごとに、そのクライアントと同じ合言葉を持つユーザーのリストを作って送る
	for client := range h.clients {
		users := []User{}
		// オンラインユーザー
		h.mu.RLock()
		for _, other := range h.usernames {
			if other.username != "" && other.passcode == client.passcode {
				// 隠密プロファイルのフィルタリング
				if other.isHidden && !client.isAdmin && client.username != other.username {
					continue
				}
				users = append(users, User{
					Username: other.username,
					Role:     other.role,
					Mode:     other.mode,
					IsOnline: true,
					IsAdmin:  other.isAdmin,
					IsMentor: other.isMentor,
				})
			}
		}
		// 離席猶予中のユーザーもリストに含める（IsOnline: false、かつオンラインに存在しない場合のみ）
		for name, off := range h.offlineUsers {
			if off.Passcode == client.passcode {
				// 重複チェック: すでにオンラインリストにいればスキップ
				existsOnline := false
				for _, other := range h.usernames {
					if other.username == name {
						existsOnline = true
						break
					}
				}
				if existsOnline {
					continue
				}
				// 隠密フィルタリング
				if off.IsHidden && !client.isAdmin && client.username != off.Username {
					continue
				}
				users = append(users, User{
					Username: off.Username,
					Role:     off.Role,
					Mode:     off.Mode,
					IsOnline: false,
					IsAdmin:  off.IsAdmin,
				})
			}
		}
		h.mu.RUnlock()
		msg := Message{Type: "user_list", Users: users}
		data, err := json.Marshal(msg)
		if err != nil {
			continue
		}
		select {
		case client.send <- data:
		default:
			close(client.send)
			delete(h.clients, client)
		}
	}
}

// sendToUser は指定ユーザーのクライアントへ直接送信する
func (h *Hub) sendToUser(username string, data []byte) {
	h.mu.RLock()
	c, ok := h.usernames[username]
	h.mu.RUnlock()
	if ok {
		select {
		case c.send <- data:
		default:
			close(c.send)
			delete(h.clients, c)
			delete(h.usernames, username)
		}
	}
}

// IsUsernameTaken は指定された名前が既に使用されているか確認する
func (h *Hub) IsUsernameTaken(name string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if _, ok := h.usernames[name]; ok {
		return true
	}
	if _, ok := h.offlineUsers[name]; ok {
		return true
	}
	return false
}

// nowJST は現在の日本時間をRFC3339形式で返す
func nowJST() string {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return time.Now().Format(time.RFC3339)
	}
	return time.Now().In(loc).Format(time.RFC3339)
}

// buildEffectiveRoom はモードに応じたプレフィックスを付与して部屋を隔離する
func buildEffectiveRoom(mode, passcode string) string {
	if mode == "chat" || mode == "" {
		_, raw := splitEffectiveRoom(passcode)
		return raw
	}
	prefix := mode + "|"
	if strings.HasPrefix(passcode, prefix) {
		return passcode
	}
	_, raw := splitEffectiveRoom(passcode)
	return prefix + raw
}

// splitEffectiveRoom は内部的なルームIDを分解する
func splitEffectiveRoom(passcode string) (string, string) {
	if strings.HasPrefix(passcode, "GroupDiscussion|") {
		return "GroupDiscussion", strings.TrimPrefix(passcode, "GroupDiscussion|")
	}
	if strings.HasPrefix(passcode, "interview|") {
		return "interview", strings.TrimPrefix(passcode, "interview|")
	}
	// 万一、他の形式で保存されている場合への備え
	if strings.Contains(passcode, "|") {
		parts := strings.SplitN(passcode, "|", 2)
		return parts[0], parts[1]
	}
	return "chat", passcode
}

// handleAdminAction は管理者からの特別なコマンドを処理する
func handleAdminAction(h *Hub, c *Client, msg Message) {
	if !c.isAdmin && !c.isMentor {
		log.Printf("不正な権限操作試行: %s", c.username)
		return
	}

	// メンターはキックと改名のみ許可
	if c.isMentor && !c.isAdmin {
		if msg.Type != "kick" && msg.Type != "rename_user" {
			log.Printf("メンターの権限外操作試行: %s (%s)", c.username, msg.Type)
			return
		}
	}

	switch msg.Type {
	case "kick":
		target := msg.Content // キック対象のユーザー名
		h.mu.Lock()
		tClient, isOnline := h.usernames[target]
		offUser, isOffline := h.offlineUsers[target]

		// メンターは管理者を操作できない
		if c.isMentor && !c.isAdmin {
			if (isOnline && tClient.isAdmin) || (isOffline && offUser.IsAdmin) {
				h.mu.Unlock()
				errMsg, _ := json.Marshal(Message{
					Type:    "action_error",
					Content: "管理者を退場させることはできません",
				})
				c.send <- errMsg
				return
			}
		}

		// オフラインユーザー（離席中）も削除
		if isOffline {
			delete(h.offlineUsers, target)
			log.Printf("管理者 %s が離席中の %s をリストから削除しました", c.username, target)
		}
		h.mu.Unlock()

		if isOnline && tClient != nil {
			// ログアウト扱いで切断（これで unregister 時に猶予リストに入らなくなる）
			tClient.forceLeave = true
			
			// キック通知を送信 (非ブロッキング)
			kickMsg, _ := json.Marshal(Message{
				Type:    "kicked",
				Content: "管理者に強制退出させられました",
			})
			select {
			case tClient.send <- kickMsg:
			default:
			}
			
			// メッセージを送信後、クライアント側で自ら接続を閉じる（handleKicked 内）のを待ちます。
			// サーバー側で即座に Close() すると、通知が届く前に通信が切れる可能性があるため。
			log.Printf("管理者 %s がオンラインの %s に退場通知を送信しました", c.username, target)
		}
		h.broadcastUserList() // ユーザーリストを更新して全員に配信

	case "rename_user":
		oldName := msg.Username // 対象の現在の名前
		newName := msg.Content  // 新しい名前
		if oldName == "" || newName == "" {
			return
		}

		h.mu.Lock()
		client, isOnline := h.usernames[oldName]
		offUser, isOffline := h.offlineUsers[oldName]

		// メンターは管理者を操作できない
		if c.isMentor && !c.isAdmin {
			if (isOnline && client.isAdmin) || (isOffline && offUser.IsAdmin) {
				h.mu.Unlock()
				errMsg, _ := json.Marshal(Message{
					Type:    "action_error",
					Content: "管理者を改名することはできません",
				})
				c.send <- errMsg
				return
			}
		}

		if !isOnline && !isOffline {
			// どこにも存在しない場合は何もしない
			h.mu.Unlock()
			break
		}

		if !isOnline && isOffline {
			h.mu.Unlock()
			errMsg, _ := json.Marshal(Message{
				Type:    "action_error",
				Content: "ユーザーが離席中です",
			})
			c.send <- errMsg
			return
		}

		// 改名対象のパスコードを取得
		var targetPasscode string

		// オンラインユーザーのusernamesを更新
		if isOnline {
			delete(h.usernames, oldName)
			client.username = newName
			h.usernames[newName] = client
			targetPasscode = client.passcode
		}

		// 離席中ユーザーのofflineUsersも更新（離席中でも改名を反映）
		if isOffline {
			offUser.Username = newName
			delete(h.offlineUsers, oldName)
			h.offlineUsers[newName] = offUser
			if targetPasscode == "" {
				targetPasscode = offUser.Passcode
			}
		}

		// DB更新 (メッセージ送信者名を一括置換)
		renameUserInDB(oldName, newName)

		// ルーム全員に通知
		renameMsg, _ := json.Marshal(Message{
			Type:     "user_renamed",
			Username: oldName, // 旧名
			Content:  newName, // 新名
			Passcode: targetPasscode,
		})
		h.mu.Unlock()
		// broadcastRaw ではなく通常の broadcast チャンネルへ流すことで合言葉フィルタリングを適用
		h.broadcast <- BroadcastEntry{data: renameMsg, msgType: "user_renamed"}
		h.broadcastUserList()
		log.Printf("管理者 %s が %s を %s に改名しました", c.username, oldName, newName)

	case "ghost_toggle":
		c.isHidden = !c.isHidden
		log.Printf("管理者 %s のゴーストモード: %v", c.username, c.isHidden)

		h.broadcastUserList()

	case "room_reset":
		// 現在のモードのチャット履歴のみ消去
		passcode := c.passcode
		if msg.Passcode != "" {
			passcode = msg.Passcode
		}
		
		clearChatHistory(passcode)
		
		// この操作によって部屋が完全に空になった場合はパトロール対象として削除
		_, rawReset := splitEffectiveRoom(passcode)
		h.CheckEmptyRoom(rawReset)
		
		// 該当モードの参加者のみにリセット通知
		resetMsg, _ := json.Marshal(Message{
			Type:     "room_reset",
			Content:  "現在のチャット履歴が管理者によってクリアされました",
			Passcode: passcode,
		})
		// broadcastRaw ではなく通常の broadcast チャンネルへ流すことで合言葉フィルタリングを適用
		h.broadcast <- BroadcastEntry{data: resetMsg, msgType: "room_reset"}
		h.broadcastAdminRoomsList()
		log.Printf("管理者 %s がチャット %s の履歴をクリアしました", c.username, passcode)

	case "admin_get_rooms":
		// 管理者からの手動更新時（リフレッシュボタン押下など）にもパトロール（空部屋削除）を実行する
		allPasscodes := getAllPasscodesWithData()
		for _, pc := range allPasscodes {
			_, rawPass := splitEffectiveRoom(pc)
			if rawPass != "" {
				h.CheckEmptyRoom(rawPass)
			}
		}

		// 全アクティブ部屋リストを返却
		rooms := h.getActiveRooms()
		resp, _ := json.Marshal(Message{
			Type:  "admin_rooms_list",
			Users: rooms, // roomsをUserリスト形式（名前=パスコード, Role=人数）で流用
		})
		select {
		case c.send <- resp:
		default:
		}

	case "admin_delete_room":
		rawPass := msg.Content
		if rawPass == "" {
			return
		}
		
		// 全バリエーション（通常, GroupDiscussion, 面接）のユーザーを特定してキック
		variants := []string{rawPass, "GroupDiscussion|" + rawPass, "interview|" + rawPass}
		var targets []*Client
		h.mu.RLock()
		for client := range h.clients {
			for _, v := range variants {
				if client.passcode == v {
					targets = append(targets, client)
					break
				}
			}
		}
		h.mu.RUnlock()

		kickMsg, _ := json.Marshal(Message{
			Type:    "kicked",
			Content: "管理者が部屋を閉鎖しました",
		})
		for _, cl := range targets {
			if cl.isAdmin {
				// 管理者は退出させず、メインルームへ強制移動させる
				cl.passcode = ""
				cl.mode = "chat"
				
				// クライアント側の状態を同期させるために welcome メッセージを送信
				welcomeMsg := Message{
					Type:     "welcome",
					IsAdmin:  cl.isAdmin,
					IsMentor: cl.isMentor,
					IsHidden: cl.isHidden,
					Mode:     "chat",
					Role:     cl.role,
					Passcode: "", // メインルームは空文字
				}
				data, _ := json.Marshal(welcomeMsg)
				select {
				case cl.send <- data:
				default:
				}
				log.Printf("システム移動(一括削除時): 管理者 %s をメインルームへ戻しました", cl.username)
				continue
			}

			cl.forceLeave = true
			select {
			case cl.send <- kickMsg:
			default:
			}
			h.unregister <- cl
		}

		// DBから全バリエーションのデータを一括削除
		clearRoomData(rawPass)
		
		// 全管理者に最新情報を配信
		h.broadcastUserList()
		h.broadcastAdminRoomsList()
		log.Printf("管理者 %s が部屋 %s (全モード) を一括削除しました", c.username, rawPass)

	case "admin_get_peek_history":
		targetPass := msg.Passcode
		// その部屋の履歴を取得 (制限なしで多めに取得)
		history := getRecentMessages(500, targetPass)
		resp, _ := json.Marshal(Message{
			Type: "admin_peek_history",
			Users: h.convertMessagesToUsers(history), // 便宜上UsersフィールドをMsgリスト送信に再利用
			Content: targetPass,
		})
		select {
		case c.send <- resp:
		default:
		}

	case "admin_join_room":
		targetPass := msg.Passcode
		// 移動先の合言葉からモードを自動判定
		targetMode, rawPass := splitEffectiveRoom(targetPass)
		
		// もし生の合言葉(プレフィックスなし)で送られてきた場合、
		// サーバー側の記録(lastActiveMode)から最適なジャンプ先を決定する
		if targetPass == rawPass {
			h.mu.RLock()
			lastMode := h.lastActiveMode[rawPass]
			h.mu.RUnlock()
			
			if lastMode != "" && lastMode != "chat" {
				targetMode = lastMode
				targetPass = lastMode + "|" + rawPass
			}
		}

		oldPass := c.passcode
		c.mode = targetMode
		c.passcode = targetPass
		log.Printf("管理者 %s が部屋 %s (mode=%s) に移動しました", c.username, c.passcode, c.mode)
		c.send <- []byte(`{"type":"admin_join_room_ack"}`)

		// Welcomeメッセージにはクリーンな（接頭辞なしの）合言葉を含める
		welcome, _ := json.Marshal(Message{
			Type:     "welcome",
			IsAdmin:  c.isAdmin,
			IsMentor: c.isMentor,
			IsHidden: c.isHidden,
			Mode:     c.mode,
			Role:     c.role,
			Passcode: rawPass,
			Content:  "ルームを移動しました",
		})
		c.send <- welcome

		// 2. 以前の部屋に退出通知 (管理者のため抑制)
		// 以前の実装では通知を出していましたが、ステルス性が求められるため削除しました

		// 3. 新しい部屋の履歴を送信
		if d, err := json.Marshal(Message{Type: "history_sep", Content: "start"}); err == nil {
			c.send <- d
		}
		recentMsgs := getRecentMessages(200, c.passcode)
		for _, hMsg := range recentMsgs {
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

		// 4. 新しい部屋の共有メモを同期
		gdNote := getGDNote(c.passcode)
		if d, err := json.Marshal(Message{Type: "note_update", Note: gdNote}); err == nil {
			c.send <- d
		}

		// 5. 新しい部屋への入室通知 (管理者のため抑制)

		// 6. ユーザーリスト更新
		h.broadcastUserList()

		_, oldRaw := splitEffectiveRoom(oldPass)
		h.CheckEmptyRoom(oldRaw)
		h.broadcastAdminRoomsList()

	case "admin_broadcast":

		// サーバー全体への一斉システム通知
		content := msg.Content
		if content == "" {
			return
		}
		broadcastMsg, _ := json.Marshal(Message{
			Type:      "system",
			Content:   "[全体通知] " + content,
			Timestamp: nowJST(),
		})
		// broadcastRawを使って全接続クライアントへ送信
		h.broadcastRaw(broadcastMsg, "system")
		log.Printf("管理者 %s が全体通知を送信しました: %s", c.username, content)
	}
}

// convertMessagesToUsers はMessageのスライスを、フロントエンドへ送るためのUserスライス（ダミー）へ変換する
func (h *Hub) convertMessagesToUsers(msgs []*Message) []User {
	res := make([]User, 0)
	for _, m := range msgs {
		res = append(res, User{
			Username: m.Username,
			Role:     m.Content,   // ContentをRoleに入れる
			Mode:     m.Timestamp, // TimestampをModeに入れる
			IsOnline: m.Type == "image", // 画像かどうかをフラグとして流用
		})
	}
	return res
}

// getActiveRooms は全部屋のパスコード・人数・最終日時を返す
func (h *Hub) getActiveRooms() []User {
	type roomAgg struct {
		count int
		last  string
	}
	agg := make(map[string]*roomAgg)
	
	// メインルームを常に確保
	agg[""] = &roomAgg{last: "chat"}

	// 1. DBから履歴・メモがある部屋をすべて取得（初期化）
	allPasscodes := getAllPasscodesWithData()
	for _, pc := range allPasscodes {
		_, raw := splitEffectiveRoom(pc)
		if agg[raw] == nil {
			agg[raw] = &roomAgg{last: "chat"}
		}
	}

	// 2. 現在オンラインの人数を加算。
	// また、DBやメモリ上の記録から「最新のアクティブモード」を決定する
	activityMap := getLastActivityByPasscode()
	h.mu.RLock()
	for _, cl := range h.usernames {
		_, raw := splitEffectiveRoom(cl.passcode)
		if agg[raw] == nil { agg[raw] = &roomAgg{last: "chat"} }
		agg[raw].count++
	}

	// 各部屋の「最新の表示タグ（モード）」を決定
	// 優先順位: 
	// 1. 現在オンラインのユーザーのモード (がいればそれを最新とみなす)
	// 2. lastActiveMode (メモリ上の直近の活動)
	// 3. DBから取得した「最後に活動があった時のモード」
	for raw, info := range agg {
		onlineMode := ""
		// オンラインユーザーから抽出
		for _, cl := range h.usernames {
			clMode, clRaw := splitEffectiveRoom(cl.passcode)
			if clRaw == raw {
				onlineMode = clMode
				break
			}
		}

		if onlineMode != "" {
			info.last = onlineMode
		} else if m, ok := h.lastActiveMode[raw]; ok && m != "" {
			info.last = m
		} else if dbInfo, ok := activityMap[raw]; ok && dbInfo.Mode != "" {
			info.last = dbInfo.Mode
		}
	}
	h.mu.RUnlock()

	res := make([]User, 0)
	for pass, info := range agg {
		res = append(res, User{
			Username:  pass,
			Role:      fmt.Sprintf("%d", info.count),
			Mode:      info.last,
			Timestamp: activityMap[pass].Timestamp,
		})
	}

	// ソート実行: メインルーム("")を最上位、それ以外を人数 > 最終発言日時 > 合言葉
	sort.Slice(res, func(i, j int) bool {
		// 優先度1: メインルームを常に1番目にする
		if res[i].Username == "" {
			return true
		}
		if res[j].Username == "" {
			return false
		}
		// 優先度2: 人数の降順
		countI, _ := strconv.Atoi(res[i].Role)
		countJ, _ := strconv.Atoi(res[j].Role)
		if countI != countJ {
			return countI > countJ
		}

		// 優先度3: 最終アクティビティ日時の降順
		lastI := activityMap[res[i].Username].Timestamp
		lastJ := activityMap[res[j].Username].Timestamp
		if lastI != lastJ {
			return lastI > lastJ
		}

		// 優先度4: 日時も同じなら合言葉の辞書順
		return res[i].Username < res[j].Username
	})

	return res
}

// deleteFullRoom は指定パスコードの部屋を完全に消滅させる
func (h *Hub) deleteFullRoom(passcode string) {
	// DBから削除
	clearRoomData(passcode)
	
	// 全員キック
	h.mu.RLock()
	targets := make([]*Client, 0)
	for _, cl := range h.usernames {
		if cl.passcode == passcode {
			targets = append(targets, cl)
		}
	}
	h.mu.RUnlock()

	kickMsg, _ := json.Marshal(Message{
		Type:    "kicked",
		Content: "管理者に強制退出させられました（部屋削除）",
	})
	for _, cl := range targets {
		if cl.isAdmin {
			// 管理者は退出させず、メインルームへ強制移動させる
			cl.passcode = ""
			cl.mode = "chat"
			
			// クライアント側の状態を同期させるために welcome メッセージを送信
			welcomeMsg := Message{
				Type:     "welcome",
				IsAdmin:  cl.isAdmin,
				IsMentor: cl.isMentor,
				IsHidden: cl.isHidden,
				Mode:     "chat",
				Role:     cl.role,
				Passcode: "", // メインルームは空文字
			}
			data, _ := json.Marshal(welcomeMsg)
			select {
			case cl.send <- data:
			default:
			}
			log.Printf("システム移動: 管理者 %s をメインルームへ戻しました", cl.username)
			continue
		}

		select {
		case cl.send <- kickMsg:
		default:
		}
		h.unregister <- cl
	}
}
// broadcastAdminRoomsList は全管理者に最新のルームリストを配信する
func (h *Hub) broadcastAdminRoomsList() {
	rooms := h.getActiveRooms()

	res, _ := json.Marshal(Message{
		Type:  "admin_rooms_list",
		Users: rooms,
	})
	
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		if client.isAdmin {
			select {
			case client.send <- res:
			default:
			}
		}
	}
}

// CheckEmptyRoom は指定された合言葉の部屋に参加者がおらず、DBも空であれば削除する
func (h *Hub) CheckEmptyRoom(rawPass string) {
	if rawPass == "" {
		return
	}
	
	h.mu.RLock()
	anyActive := false
	for _, other := range h.usernames {
		_, otherRaw := splitEffectiveRoom(other.passcode)
		if otherRaw == rawPass {
			anyActive = true
			break
		}
	}
	anyOffline := false
	if !anyActive {
		for _, off := range h.offlineUsers {
			_, offRaw := splitEffectiveRoom(off.Passcode)
			if offRaw == rawPass {
				anyOffline = true
				break
			}
		}
	}
	h.mu.RUnlock()

	if !anyActive && !anyOffline {
		if isRoomEmpty(rawPass) {
			clearRoomData(rawPass)
			log.Printf("自動削除: 空の部屋 %s をDBから削除しました", rawPass)
			h.broadcastAdminRoomsList()
		}
	}
}
