package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 32 * 1024 // 32KB（テキストメッセージ上限）
)

// Client はWebSocket接続ごとの状態を保持する
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	send      chan []byte
	username  string
	mode      string // "chat" | "interview" | "gd" | "secret"
	role      string // "interviewer" | "interviewee" | "observer" | "moderator" | "secretary" | "presenter" | "participant"
	passcode  string // ルームを分けるための合言葉
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

	for {
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
			c.username = msg.Username
			c.mode = msg.Mode
			c.role = msg.Role
			c.passcode = msg.Passcode

			// ユーザー登録（DBへ）
			saveUserRegister(c.username)
			log.Printf("ユーザー登録: %s (mode=%s, passcode=%s)", c.username, c.mode, c.passcode)

			// ── 過去の履歴をDBから取得しこのクライアントだけに送信 ──
			recentMsgs := getRecentMessages(200, c.passcode)

			if len(recentMsgs) > 0 {
				// 履歴開始マーカー
				if d, err := json.Marshal(Message{Type: "history_sep", Content: "start"}); err == nil {
					c.send <- d
				}
				for _, hMsg := range recentMsgs {
					// 面接官専用は面接官のみに送る
					if hMsg.Type == "interviewer_chat" && c.role != "interviewer" {
						continue
					}
					// DMの場合は当事者のみに送る
					if hMsg.Type == "dm" && c.username != hMsg.Username && c.username != hMsg.To {
						continue
					}
					if d, err := json.Marshal(hMsg); err == nil {
						select {
						case c.send <- d:
						default:
						}
					}
				}
				// 履歴終了マーカー
				if d, err := json.Marshal(Message{Type: "history_sep", Content: "end"}); err == nil {
					c.send <- d
				}
			}

			// 最新のGD共有メモをDBから取得し送信（GDモードでない場合も一旦送っておく）
			gdNote := getGDNote(c.passcode)
			if d, err := json.Marshal(Message{Type: "note_update", Note: gdNote}); err == nil {
				c.send <- d
			}


			// 入室通知（全体へブロードキャスト）
			sysMsg := Message{
				Type:      "system",
				Content:   c.username + " さんが入室しました",
				Timestamp: nowJST(),
				Passcode:  c.passcode,
			}
			if c.mode == "interview" {
				sysMsg.NoHistory = true
			}
			data, _ := json.Marshal(sysMsg)
			c.hub.broadcast <- BroadcastEntry{data: data, msgType: "system"}
			// usernameマップに登録してユーザーリストを更新
			c.hub.userJoined <- c
			continue
		}

		// mode_changeメッセージ処理: サーバー側のmode/role/passcodeを更新
		if msg.Type == "mode_change" {
			oldMode := c.mode
			oldPass := c.passcode
			c.mode = msg.Mode
			c.role = msg.Role
			c.passcode = msg.Passcode
			log.Printf("モード変更: %s -> mode=%s, role=%s, passcode=%s", c.username, c.mode, c.role, c.passcode)

			// 部屋が変わった場合（モードまたは合言葉が変更された場合）、新しい履歴を送信
			if oldMode != c.mode || oldPass != c.passcode {
				recentMsgs := getRecentMessages(200, c.passcode)
				if len(recentMsgs) > 0 {
					if d, err := json.Marshal(Message{Type: "history_sep", Content: "start"}); err == nil {
						c.send <- d
					}
					for _, hMsg := range recentMsgs {
						if d, err := json.Marshal(hMsg); err == nil {
							c.send <- d
						}
					}
					if d, err := json.Marshal(Message{Type: "history_sep", Content: "end"}); err == nil {
						c.send <- d
					}
				}
				// 部屋が変わったので、新しい部屋の共有メモ（GDNote）も取得して送信する
				gdNote := getGDNote(c.passcode)
				if d, err := json.Marshal(Message{Type: "note_update", Note: gdNote}); err == nil {
					c.send <- d
				}
			}

			// モードや役割が変更されたのでユーザーリストを再配信
			c.hub.userJoined <- c
			continue
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

		// dmメッセージ処理: 全体履歴に保存し当事者のみに配信
		if msg.Type == "dm" {
			if msg.To != "" && msg.To != c.username {
				msg.Username = c.username
				msg.Timestamp = nowJST()
				msg.Passcode = c.passcode // DMにも合言葉を付与（合言葉なしDMなら空）
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
		// text/image/interviewer_chatにはUUIDを付与（取り消し機能のため）
		if msg.Type != "note_update" && msg.ID == "" {
			msg.ID = uuid.New().String()
		}
		
		// 面接練習モードの場合はチャット履歴を残さない（DBに保存しない）
		if c.mode == "interview" {
			msg.NoHistory = true
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
