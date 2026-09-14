FROM node:20-bookworm-slim

WORKDIR /app

# تثبيت Chromium وكل المكتبات المطلوبة لتشغيله
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# مكان حفظ جلسة WhatsApp
RUN mkdir -p /data/wwebjs_auth

EXPOSE 3000

CMD ["node", "server.js"]
