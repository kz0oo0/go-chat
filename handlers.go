package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// ────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────

// Message はWebSocketで送受信するメッセージの構造体
type Message struct {
	ID        string   `json:"id,omitempty"`
	Type      string   `json:"type"`
	Username  string   `json:"username"`
	Content   string   `json:"content"`
	Timestamp string   `json:"timestamp"`
	Role      string   `json:"role"`
	Mode      string   `json:"mode"`
	To        string   `json:"to,omitempty"`
	Passcode  string   `json:"passcode"`
	AdminPass string   `json:"admin_pass,omitempty"`
	Users     []User   `json:"users"`
	Note           *GDNote  `json:"note,omitempty"`
	NoHistory      bool     `json:"noHistory,omitempty"` // trueの場合、サーバーの履歴に保存しない
	IsOnline       bool     `json:"is_online"`           // ステータス変更用
	MsgContentType string   `json:"msgContentType,omitempty"` // 画像等のコンテンツ種別
	IsMobile       bool     `json:"isMobile,omitempty"`      // デバイス種別判別用
	IsAutoLogin    bool     `json:"isAutoLogin,omitempty"`   // 自動復帰・リロード時のフラグ
	IsAdmin        bool     `json:"isAdmin,omitempty"`       // 管理者権限フラグ
	IsMentor       bool     `json:"isMentor,omitempty"`      // メンター権限フラグ
	IsHidden       bool     `json:"isHidden,omitempty"`      // ゴーストモード用フラグ
}

// User はユーザーの基本情報を保持する
type User struct {
	Username  string `json:"username"`
	Role      string `json:"role"`
	Mode      string `json:"mode"`
	IsOnline  bool   `json:"is_online"`
	IsAdmin   bool   `json:"isAdmin,omitempty"`
	IsMentor  bool   `json:"isMentor,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
}

// GDNote はGD練習モードの共有メモ構造体
type GDNote struct {
	Theme      string `json:"theme"`
	Premise    string `json:"premise"`
	Issues     string `json:"issues"`
	Opinions   string `json:"opinions"`
	Conclusion string `json:"conclusion"`
	Summary    string `json:"summary"`
	EditMode   string `json:"editMode"` // "secretary" | "all"
}

// ────────────────────────────────────────────────────────────
// WebSocket
// ────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// 開発用: 全オリジン許可
	CheckOrigin: func(r *http.Request) bool { return true },
}

var tmpl = template.Must(template.ParseFiles("templates/index.html"))

// indexHandler はチャット画面のHTMLを返す
func indexHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if err := tmpl.Execute(w, nil); err != nil {
		log.Printf("template error: %v", err)
	}
}

// serveWs はWebSocket接続を受け付けてクライアントを生成する
func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	client := &Client{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 1024),
	}
	client.hub.register <- client
	
	go client.writePump()
	go client.readPump()
}

// ────────────────────────────────────────────────────────────
// 画像アップロード
// ────────────────────────────────────────────────────────────

const maxUploadSize = 30 * 1024 * 1024 // 30MB

var allowedExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true,
}

var allowedMIMEs = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true,
}

// uploadHandler は画像ファイルの受付・検証・保存を行う
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// ボディサイズ制限
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize+1024)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		respondError(w, http.StatusBadRequest, "ファイルサイズが大きすぎます（上限30MB）")
		return
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		respondError(w, http.StatusBadRequest, "ファイルの読み取りに失敗しました")
		return
	}
	defer file.Close()

	// MIMEタイプ検証（Content-Typeヘッダー or ファイル先頭バイト検出）
	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" || mimeType == "application/octet-stream" {
		buf := make([]byte, 512)
		n, _ := file.Read(buf)
		mimeType = http.DetectContentType(buf[:n])
		file.Seek(0, 0)
	}
	// パラメータを除去（例: "image/jpeg; charset=utf-8" → "image/jpeg"）
	mimeType, _, _ = mime.ParseMediaType(mimeType)
	if !allowedMIMEs[mimeType] {
		respondError(w, http.StatusBadRequest, "対応していないファイル形式です（jpg/jpeg/png/webp のみ）")
		return
	}

	// 拡張子を決定 (元の拡張子が正しい場合は使い、なければMIMEから補完)
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExts[ext] {
		switch mimeType {
		case "image/jpeg":
			ext = ".jpg"
		case "image/png":
			ext = ".png"
		case "image/webp":
			ext = ".webp"
		}
	}

	// 一意なファイル名を生成（UUID + 拡張子）
	id := uuid.New().String()
	filename := id + ext
	savePath := filepath.Join(dataDir, "uploads", filename)

	// ファイル保存
	dst, err := os.Create(savePath)
	if err != nil {
		log.Printf("ファイル保存失敗: %v", err)
		respondError(w, http.StatusInternalServerError, "サーバーエラーが発生しました")
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		log.Printf("ファイル書き込み失敗: %v", err)
		respondError(w, http.StatusInternalServerError, "サーバーエラーが発生しました")
		return
	}

	imageURL := fmt.Sprintf("/uploads/%s", filename)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"url": imageURL})
}

// checkNameHandler は指定されたユーザー名が使用可能かどうかを確認する
func checkNameHandler(hub *Hub, w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"available": false, "error": "名前を入力してください"})
		return
	}

	available := !hub.IsUsernameTaken(name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"available": available,
	})
}

// respondError はJSONエラーレスポンスを返す
func respondError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
