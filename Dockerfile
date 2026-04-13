# 実行ステージ
FROM alpine:latest

WORKDIR /app

# 必要なパッケージ（ライブラリなど）をインストール
RUN apk add --no-cache ca-certificates tzdata

# ローカルでビルド済みのLinuxバイナリをコピー
COPY gochat .

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
