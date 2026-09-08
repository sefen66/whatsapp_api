# استخدام Node مع تثبيت Chromium اللازم لـ whatsapp-web.js (Puppeteer)
FROM node:18-slim

# مكتبات النظام اللازمة عشان Chromium (اللي هيحمّله Puppeteer نفسه) يشتغل
# ملحوظة: مبنثبتش حزمة chromium بتاعة Debian عن قصد — نسختها ممكن متطابقتش
# مع بروتوكول CDP اللي Puppeteer متبني عليه، وده بيسبب أخطاء تايم آوت غريبة
# زي "Runtime.callFunctionOn timed out" وقت الإرسال.
RUN apt-get update && apt-get install -y \
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

WORKDIR /app

COPY package*.json ./
# مفيش PUPPETEER_SKIP_CHROMIUM_DOWNLOAD هنا، فـ npm install هيحمّل نسخة
# Chromium المتطابقة تمامًا مع نسخة Puppeteer المستخدمة في whatsapp-web.js
RUN npm install --omit=dev

COPY . .

# مجلد لحفظ جلسة واتساب حتى لا تحتاجي مسح QR في كل مرة
# (يفضّل ربط Railway Volume على هذا المسار لضمان بقاء الجلسة بعد أي إعادة نشر)
RUN mkdir -p /data/wwebjs_auth

EXPOSE 3000

CMD ["node", "server.js"]
