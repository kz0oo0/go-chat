package main

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// dataDir はアプリの永続データを保存するベースディレクトリ（環境変数 DATA_DIR または "data"）
var dataDir = getEnv("DATA_DIR", "data")
var db *sql.DB

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

// initDB はSQLiteデータベースを初期化し、必要なテーブルを作成する
func initDB() {
	var err error
	dbPath := filepath.Join(dataDir, "chat.db")
	db, err = sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("データベースのオープンに失敗しました: %v", err)
	}

	// テーブルの作成
	// messages: 一般チャットやDM履歴の保存
	// users: アバター等のユーザーメタデータ
	// gd_note: 共有メモの永続化 (1行のみのシングルトン構成)
	schema := `
	CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		type TEXT,
		username TEXT,
		content TEXT,
		timestamp TEXT,
		role TEXT,
		mode TEXT,
		to_user TEXT,
		passcode TEXT
	);

	CREATE TABLE IF NOT EXISTS users (
		username TEXT PRIMARY KEY
	);

	CREATE TABLE IF NOT EXISTS gd_notes (
		passcode TEXT PRIMARY KEY,
		theme TEXT,
		premise TEXT,
		issues TEXT,
		opinions TEXT,
		conclusion TEXT,
		summary TEXT,
		edit_mode TEXT,
		updated_at TEXT
	);
	`

	if _, err := db.Exec(schema); err != nil {
		log.Fatalf("テーブル作成に失敗しました: %v", err)
	}

	// 既存DBにpasscodeカラムがない場合は追加
	_, _ = db.Exec("ALTER TABLE messages ADD COLUMN passcode TEXT DEFAULT ''")
	// 既存DBにupdated_atがない場合は追加
	_, _ = db.Exec("ALTER TABLE gd_notes ADD COLUMN updated_at TEXT DEFAULT ''")
}

// cleanupOldData は合言葉やモードに応じた期間制限と、件数制限を適用してデータを削除する
func cleanupOldData() {
	loc, _ := time.LoadLocation("Asia/Tokyo")
	now := time.Now().In(loc)

	// 各種期限の計算
	cutoff3h := now.Add(-3 * time.Hour).Format(time.RFC3339)
	cutoff1d := now.AddDate(0, 0, -1).Format(time.RFC3339)
	cutoff14d := now.AddDate(0, 0, -14).Format(time.RFC3339)
	cutoff30d := now.AddDate(0, 0, -30).Format(time.RFC3339)

	// 1. 期限切れメッセージの削除 (時間ベース)
	// 部屋コードなしの面接練習: 3時間
	db.Exec("DELETE FROM messages WHERE passcode = '' AND mode = 'interview' AND timestamp < ?", cutoff3h)
	// 画像メッセージ: 1日
	db.Exec("DELETE FROM messages WHERE type = 'image' AND timestamp < ?", cutoff1d)
	// 部屋コードあり: 14日
	db.Exec("DELETE FROM messages WHERE passcode != '' AND timestamp < ?", cutoff14d)
	// 部屋コードなし（通常等）: 30日
	db.Exec("DELETE FROM messages WHERE passcode = '' AND mode != 'interview' AND timestamp < ?", cutoff30d)

	// 2. 件数制限による削除
	// 部屋コードあり: 最新100件、なし: 最新200件
	limitQuery := `
		DELETE FROM messages 
		WHERE id NOT IN (
			SELECT id FROM (
				SELECT id, passcode, ROW_NUMBER() OVER (PARTITION BY passcode ORDER BY timestamp DESC) as rn
				FROM messages
			) WHERE (passcode != '' AND rn <= 100) OR (passcode = '' AND rn <= 200)
		)
	`
	resL, err := db.Exec(limitQuery)
	if err == nil {
		if n, _ := resL.RowsAffected(); n > 0 {
			log.Printf("メッセージの超過分 %d 件を削除しました", n)
		}
	} else {
		log.Printf("メッセージ制限エラー: %v", err)
	}

	// 3. GDメモの削除 (合言葉あり/なしに関わらず古いものを削除。面接練習に合わせて3時間または14日...)
	// ここは安全のため合言葉ありの基準（14日）に合わせる
	resG, err := db.Exec("DELETE FROM gd_notes WHERE updated_at < ? AND updated_at != ''", cutoff14d)
	if err == nil {
		if n, _ := resG.RowsAffected(); n > 0 {
			log.Printf("古いGDメモを %d 件削除しました", n)
		}
	}

	// 4. アップロード画像の物理削除 (1日以上経過したもの)
	cleanupUploadFiles(now.Add(-24 * time.Hour))
}

// cleanupUploadFiles は uploads ディレクトリ内の古いファイルを削除する
func cleanupUploadFiles(before time.Time) {
	uploadPath := filepath.Join(dataDir, "uploads")
	files, err := os.ReadDir(uploadPath)
	if err != nil {
		log.Printf("uploadsディレクトリの読み取りエラー: %v", err)
		return
	}

	count := 0
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		info, err := file.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(before) {
			err := os.Remove(filepath.Join(uploadPath, file.Name()))
			if err == nil {
				count++
			}
		}
	}
	if count > 0 {
		log.Printf("古い画像ファイルを %d 件削除しました", count)
	}
}

// saveMessage はメッセージをDBに保存する
func saveMessage(m *Message) {
	if m == nil || m.NoHistory {
		return
	}
	
	query := `
		INSERT OR REPLACE INTO messages (id, type, username, content, timestamp, role, mode, to_user, passcode)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := db.Exec(query, m.ID, m.Type, m.Username, m.Content, m.Timestamp, m.Role, m.Mode, m.To, m.Passcode)
	if err != nil {
		log.Printf("DB保存エラー: %v", err)
	}
}

// markMessageDeleted はメッセージを論理削除（タイプをdeletedに変更）する
func markMessageDeleted(id string) {
	query := `UPDATE messages SET type = 'deleted', content = '' WHERE id = ?`
	_, err := db.Exec(query, id)
	if err != nil {
		log.Printf("DB削除更新エラー: %v", err)
	}
}

// getRecentMessages は履歴を LIMIT 件取得する（特定の合言葉に基づいたフィルタリング）
func getRecentMessages(limit int, passcode string) []*Message {
	query := `
		SELECT id, type, username, content, timestamp, role, mode, to_user, passcode 
		FROM messages 
		WHERE passcode = ? OR (type = 'dm' AND (username = ? OR to_user = ?))
		ORDER BY timestamp DESC 
		LIMIT ?
	`
	// DMの場合は送信者と受信者の関係も考慮するため、ここでは全ての履歴を一旦取ってフィルタリングするのが安全
	// ※簡略化のため、合言葉が一致するもの、もしくは自分が関わっているDMを取得
	rows, err := db.Query(query, passcode, passcode, passcode, limit)
	if err != nil {
		log.Printf("履歴取得エラー: %v", err)
		return nil
	}
	defer rows.Close()

	var msgs []*Message
	for rows.Next() {
		var m Message
		// NULL回避のために sql.NullString などを経由するのが安全
		var id, typ, user, cont, ts, role, mode, to, pc sql.NullString
		
		if err := rows.Scan(&id, &typ, &user, &cont, &ts, &role, &mode, &to, &pc); err != nil {
			log.Printf("Scanエラー: %v", err)
			continue
		}
		m.ID = id.String
		m.Type = typ.String
		m.Username = user.String
		m.Content = cont.String
		m.Timestamp = ts.String
		m.Role = role.String
		m.Mode = mode.String
		m.To = to.String
		m.Passcode = pc.String

		msgs = append(msgs, &m)
	}

	// 取得は新しい順だったので、表示用に古い順へリバースする
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	return msgs
}

// saveGDNote はGD共有メモの状態を1つのレコードに保存する
func saveGDNote(n *GDNote, passcode string) {
	if n == nil {
		return
	}
	query := `
		INSERT OR REPLACE INTO gd_notes (passcode, theme, premise, issues, opinions, conclusion, summary, edit_mode, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := db.Exec(query, passcode, n.Theme, n.Premise, n.Issues, n.Opinions, n.Conclusion, n.Summary, n.EditMode, nowJST())
	if err != nil {
		log.Printf("GDメモ保存エラー: %v", err)
	}
}

// clearGDNote はGDメモの全フィールドを空文字に更新する（部屋リセット用）
func clearGDNote(passcode string) {
	query := `
		UPDATE gd_notes 
		SET theme = '', premise = '', issues = '', opinions = '', conclusion = '', summary = '', updated_at = ?
		WHERE passcode = ?
	`
	_, err := db.Exec(query, nowJST(), passcode)
	if err != nil {
		log.Printf("GDメモクリアエラー: %v", err)
	}
}

// getGDNote は保存されたGDメモを取得する（なければ空を返す）
func getGDNote(passcode string) *GDNote {
	query := `
		SELECT theme, premise, issues, opinions, conclusion, summary, edit_mode 
		FROM gd_notes WHERE passcode = ?
	`
	row := db.QueryRow(query, passcode)
	var n GDNote
	var th, pr, is, op, co, su, em sql.NullString
	err := row.Scan(&th, &pr, &is, &op, &co, &su, &em)
	if err == sql.ErrNoRows {
		return &GDNote{EditMode: "secretary"}
	} else if err != nil {
		log.Printf("GDメモ取得エラー: %v", err)
		return &GDNote{EditMode: "secretary"}
	}
	n.Theme = th.String
	n.Premise = pr.String
	n.Issues = is.String
	n.Opinions = op.String
	n.Conclusion = co.String
	n.Summary = su.String
	n.EditMode = em.String
	return &n
}

// saveUserRegister はユーザーをDBに登録する（重複許容）
func saveUserRegister(username string) {
	query := `INSERT OR IGNORE INTO users (username) VALUES (?)`
	_, err := db.Exec(query, username)
	if err != nil {
		log.Printf("ユーザー保存エラー: %v", err)
	}
}
