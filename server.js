// ============================================================
// سيرفر وسيط بين منصة Mrs Sally التعليمية وواتساب
// يعتمد على مكتبة whatsapp-web.js (تشغّل واتساب ويب حقيقي عن طريق متصفح مخفي)
// ============================================================

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());

// مفتاح أمان اختياري: لو حددتِ متغير بيئة API_KEY على Railway،
// هيتم رفض أي طلب مايبعتش نفس المفتاح في الهيدر x-api-key
const API_KEY = process.env.API_KEY || '';
function checkApiKey(req, res, next) {
    if (!API_KEY) return next(); // لو مفيش مفتاح متظبط، السيرفر مفتوح (للتجربة فقط)
    const provided = req.header('x-api-key');
    if (provided !== API_KEY) {
        return res.status(401).json({ error: 'مفتاح API غير صحيح' });
    }
    next();
}

// ------------------------------------------------------------
// حالة الاتصال بواتساب
// ------------------------------------------------------------
let latestQr = null;      // آخر QR كود (Data URL) لسه محتاج مسح
let isReady = false;      // هل واتساب متصل وجاهز للإرسال
let statusText = 'starting'; // starting | qr | authenticated | ready | disconnected

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/data/wwebjs_auth' }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    statusText = 'qr';
    isReady = false;
    latestQr = await QRCode.toDataURL(qr);
    console.log('QR جديد جاهز للمسح، افتحي قسم إرسال الدرجات في الموقع.');
});

client.on('authenticated', () => {
    statusText = 'authenticated';
    console.log('تم التوثيق بنجاح، جاري تجهيز الاتصال...');
});

client.on('ready', () => {
    statusText = 'ready';
    isReady = true;
    latestQr = null;
    console.log('واتساب متصل وجاهز للإرسال ✅');
});

client.on('disconnected', (reason) => {
    statusText = 'disconnected';
    isReady = false;
    latestQr = null;
    console.log('انقطع الاتصال بواتساب:', reason);
    client.initialize();
});

client.on('auth_failure', (msg) => {
    statusText = 'auth_failure';
    isReady = false;
    console.error('فشل التوثيق:', msg);
});

client.initialize();

// ------------------------------------------------------------
// المسارات (Endpoints)
// ------------------------------------------------------------

// حالة الاتصال الحالية
app.get('/status', checkApiKey, (req, res) => {
    res.json({ connected: isReady, status: statusText });
});

// آخر QR كود متاح للمسح (null لو متصل بالفعل)
app.get('/qr', checkApiKey, (req, res) => {
    res.json({ qr: latestQr, status: statusText });
});

// تسجيل الخروج وإعادة توليد QR جديد (لو حبيتِ تغيّري الرقم المربوط)
app.post('/logout', checkApiKey, async (req, res) => {
    try {
        await client.logout();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// إرسال رسالة واتساب فعلية ومباشرة (بدون فتح أي نافذة)
// body: { phone: "201001234567", message: "نص الرسالة" }
app.post('/send-message', checkApiKey, async (req, res) => {
    try {
        if (!isReady) {
            return res.status(400).json({ error: 'واتساب غير متصل بعد، امسحي كود QR أولاً' });
        }
        const { phone, message } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ error: 'الرجاء إرسال رقم الهاتف ونص الرسالة' });
        }
        const chatId = `${String(phone).replace(/[^0-9]/g, '')}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('Sally WhatsApp Bridge is running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`السيرفر شغال على البورت ${PORT}`);
});
