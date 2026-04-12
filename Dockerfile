# ビルドステージ
FROM golang:1.25-alpine AS builder

WORKDIR /app

# 依存関係の解決に必要な最小限の構成
RUN apk add --no-cache git

# モジュール定義をコピーしてダウンロード
COPY go.mod go.sum ./
RUN go mod download

# ソースコード全体をコピー
COPY . .

# 依存関係（go.sum）の不整合を解消
RUN go mod tidy

# アプリケーションをビルド
RUN go build -o gochat .

# 実行ステージ
FROM alpine:latest

WORKDIR /app

# 必要なパッケージ（ライブラリなど）をインストール
RUN apk add --no-cache ca-certificates tzdata

# ビルドしたバイナリをコピー
COPY --from=builder /app/gochat .

# 静的コンテンツとテンプレートをコピー
COPY static ./static
COPY templates ./templates

# ポート番号の設定
EXPOSE 8080

# 環境変数のデフォルト値
ENV PORT=8080
ENV DATA_DIR=/app/data

# 実行
CMD ["./gochat"]
