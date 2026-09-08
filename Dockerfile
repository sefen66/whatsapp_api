# استخدام Node مع تثبيت Chromium اللازم لـ whatsapp-web.js (Puppeteer)
FROM node:18-slim

# مكتبات النظام اللازمة عشان Chromium (اللي هيحمّله Puppeteer نفسه) يشتغل.
# بنثبّت حزمة chromium بتاعة Debian هنا لسبب واحد بس: إنها بتسحب معاها
# تلقائيًا *كل* الـ shared libraries الصحيحة والمتوافقة مع بعضها (libgbm1
# وغيرها كتير) بدل ما نحاول نحصرهم واحدة واحدة يدويًا ونفضل نلاقي أخطاء
# "shared library not found" واحد ورا التاني.
# مهم: مش هنستخدم النسخة دي فعليًا كمتصفح — Puppeteer هيفضل يحمّل ويشغّل
# نسخته بتاعته (لأن PUPPETEER_EXECUTABLE_PATH مش متظبط)، عشان نضمن توافق
# نسخة الـ Chrome مع بروتوكول CDP اللي whatsapp-web.js متبني عليه.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    wget \
    xdg-utils \
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
