package main

import (
	"os"
	"testing"
)

func TestDB_InitAndOperations(t *testing.T) {
	// 一時ディレクトリを作成
	tmpDir, err := os.MkdirTemp("", "gochat_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// dataDir を一時ディレクトリに向ける
	dataDir = tmpDir
	initDB()
	defer db.Close()

	// メッセージ保存のテスト
	msg := Message{
		ID:        "test-id",
		Type:      "text",
		Username:  "tester",
		Content:   "hello",
		Timestamp: "2023-01-01T00:00:00Z",
		Passcode:  "",
		Mode:      "chat",
	}

	saveMessage(&msg)

	// 履歴取得のテスト (getRecentMessages)
	history := getRecentMessages(10, "")
	if len(history) != 1 {
		t.Errorf("expected 1 message, got %d", len(history))
	} else if history[0].Content != "hello" {
		t.Errorf("expected content 'hello', got %q", history[0].Content)
	}

	// 空室判定のテスト (メッセージがあるので false になるはず)
	if isRoomEmpty("") {
		t.Error("expected isRoomEmpty(\"\") to be false")
	}

	// 存在しない部屋は true
	if !isRoomEmpty("non-existent") {
		t.Error("expected isRoomEmpty(\"non-existent\") to be true")
	}
}

func TestDB_GetLastActivity(t *testing.T) {
	tmpDir, _ := os.MkdirTemp("", "gochat_test_activity")
	defer os.RemoveAll(tmpDir)

	dataDir = tmpDir
	initDB()
	defer db.Close()

	// アクティビティ情報の保存
	msg := Message{
		ID:        "act-1",
		Type:      "text",
		Username:  "admin",
		Content:   "start",
		Timestamp: "2023-01-01T12:00:00Z",
		Passcode:  "secret",
		Mode:      "interview",
	}
	saveMessage(&msg)

	activities := getLastActivityByPasscode()
	info, ok := activities["secret"]
	if !ok {
		t.Fatal("expected activity for 'secret' not found")
	}
	if info.Timestamp != "2023-01-01T12:00:00Z" {
		t.Errorf("expected timestamp '2023-01-01T12:00:00Z', got %q", info.Timestamp)
	}
	if info.Mode != "interview" {
		t.Errorf("expected mode 'interview', got %q", info.Mode)
	}
}
