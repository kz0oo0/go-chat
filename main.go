package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	// uploadsフォルダを自動作成（dataDir/uploads）
	uploadPath := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploadPath, 0755); err != nil {
		log.Fatal("uploadsフォルダの作成に失敗:", err)
	}

	// DB初期化
	initDB()

	// 1か月（30日）以上経過したデータを1日1回削除する定期処理
	go func() {
		cleanupOldData()
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			cleanupOldData()
		}
	}()

	hub := newHub()
	go hub.run()

	// ルーティング設定
	http.HandleFunc("/", indexHandler)
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})
	http.HandleFunc("/upload", uploadHandler)
	http.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(filepath.Join(dataDir, "uploads")))))
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))

	port := getEnv("PORT", "8080")
	addr := ":" + port
	log.Printf("🚀 サーバー起動: http://localhost%s (DataDir: %s)", addr, dataDir)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal("サーバー起動失敗:", err)
	}
}
