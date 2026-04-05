package main

import (
	"encoding/json"
	"log"
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

// Hub は接続中のクライアントを管理し、メッセージをブロードキャストする
type Hub struct {
	clients      map[*Client]bool
	broadcast    chan BroadcastEntry
	register     chan *Client
	unregister   chan *Client
	deleteReq    chan deleteRequest
	clearNoteReq chan bool
	userJoined   chan *Client       // username確定後に送信
	usernames    map[string]*Client // username → Client
	lastClearTime map[string]time.Time
	mu           sync.RWMutex // usernames保護用
}

func newHub() *Hub {
	return &Hub{
		broadcast:    make(chan BroadcastEntry, 256),
		register:     make(chan *Client),
		unregister:   make(chan *Client),
		deleteReq:    make(chan deleteRequest, 32),
		clearNoteReq: make(chan bool),
		userJoined:   make(chan *Client, 16),
		usernames:    make(map[string]*Client),
		clients:      make(map[*Client]bool),
		lastClearTime: make(map[string]time.Time),
	}
}

func (h *Hub) run() {
	for {
		select {
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
				}
				h.mu.Unlock()
				close(client.send)
				log.Printf("切断: %s", client.username)

				// 退出通知（username が空の場合は通知しない）
				if client.username != "" {
					msg := Message{
						Type:      "system",
						Content:   client.username + " さんが退出しました",
						Timestamp: nowJST(),
						Passcode:  client.passcode,
					}
					data, _ := json.Marshal(msg)
					for c := range h.clients {
						if c.passcode == client.passcode {
							select {
							case c.send <- data:
							default:
								close(c.send)
								delete(h.clients, c)
							}
						}
					}
					h.broadcastUserList() // ユーザーリスト更新
				}
			}

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
						}
					} else {
						continue
					}
				case "clear_note":
					h.lastClearTime[m.Passcode] = time.Now()
					clearGDNote(m.Passcode)
				}
			}

			for client := range h.clients {
				// 面接官専用チャットは面接官のみへ配信
				if entry.msgType == "interviewer_chat" && client.role != "interviewer" {
					continue
				}
				// DMの場合は、送信者と受信者のみへ配信
				if isDm && client.username != m.Username && client.username != m.To {
					continue
				}

				// 合言葉によるフィルタリング
				if m.Passcode != client.passcode && entry.msgType != "user_list" {
					continue
				}

				select {
				case client.send <- entry.data:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}

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

		case client := <-h.userJoined:
			// username→clientマップ登録してユーザーリストを更新
			h.mu.Lock()
			h.usernames[client.username] = client
			h.mu.Unlock()
			h.broadcastUserList()
			log.Printf("ユーザー登録: %s", client.username)
		}
	}
}

// broadcastRaw は全クライアントへデータを送信する（内部用）
func (h *Hub) broadcastRaw(data []byte, msgType string) {
	for client := range h.clients {
		select {
		case client.send <- data:
		default:
			close(client.send)
			delete(h.clients, client)
		}
	}
}

// broadcastUserList はオンラインユーザーリストを合言葉（Passcode）ごとにフィルタリングして配信する
func (h *Hub) broadcastUserList() {
	// クライアントごとに、そのクライアントと同じ合言葉を持つユーザーのリストを作って送る
	for client := range h.clients {
		users := make([]User, 0)
		h.mu.RLock()
		for _, other := range h.usernames {
			if other.passcode == client.passcode {
				users = append(users, User{
					Username: other.username,
					Role:     other.role,
					Mode:     other.mode,
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
	_, ok := h.usernames[name]
	return ok
}

// nowJST は現在の日本時間をRFC3339形式で返す
func nowJST() string {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return time.Now().Format(time.RFC3339)
	}
	return time.Now().In(loc).Format(time.RFC3339)
}

// buildEffectiveRoom はモードとユーザー入力のpasscodeを組み合わせた
// 内部的なルームキーを返す。
// これにより、部屋コードなしでも面接/GD/通常チャットが独立した部屋になる。
func buildEffectiveRoom(mode, passcode string) string {
	switch mode {
	case "interview":
		return "interview|" + passcode
	case "gd":
		return "gd|" + passcode
	default:
		return passcode
	}
}
