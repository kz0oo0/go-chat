# ビルド用コンテナ
FROM golang:alpine AS builder

WORKDIR /app

# 依存パッケージのキャッシュ用
COPY go.mod go.sum ./
RUN go mod download

# ソースコードをコピーしてビルド
COPY . .
# CGO_ENABLED=0 を指定して完全な静的バイナリを作成（Alpineなどで動かすため）
RUN CGO_ENABLED=0 GOOS=linux go build -o gochat .

# 実行用コンテナ（軽量なAlpineを使用）
FROM alpine:latest

WORKDIR /app

# タイムゾーンデータをインストール（JSTで時間を正しく扱うため）
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime && \
    echo "Asia/Tokyo" > /etc/timezone

# 静的ファイルとテンプレートをコピー
COPY --from=builder /app/static ./static
COPY --from=builder /app/templates ./templates

# コンパイル済みのバイナリをコピー
COPY --from=builder /app/gochat .

# データ保存用のディレクトリを作成
RUN mkdir -p /app/data

# ポートの公開
EXPOSE 8080

# アプリの実行
CMD ["./gochat"]
