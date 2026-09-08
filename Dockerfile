# استخدام Node مع تثبيت Chromium اللازم لـ whatsapp-web.js (Puppeteer)
FROM node:18-slim

# تثبيت Chromium والمكتبات المطلوبة لتشغيله
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# إخبار Puppeteer باستخدام Chromium المثبت بدلاً من تنزيل نسخة جديدة
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# مجلد لحفظ جلسة واتساب حتى لا تحتاجي مسح QR في كل مرة
# (يفضّل ربط Railway Volume على هذا المسار لضمان بقاء الجلسة بعد أي إعادة نشر)
RUN mkdir -p /data/wwebjs_auth

EXPOSE 3000

CMD ["node", "server.js"]
