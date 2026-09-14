FROM node:20-bookworm-slim

WORKDIR /app

# Chromium + المكتبات اللازمة لتشغيله
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# تثبيت Dependencies
COPY package*.json ./
RUN npm install --omit=dev

# نسخ المشروع
COPY . .

# مجلد جلسة WhatsApp
RUN mkdir -p /data/wwebjs_auth

EXPOSE 3000

CMD ["node", "server.js"]
