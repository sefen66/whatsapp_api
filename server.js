// ============================================================
// سيرفر وسيط بين منصة Mrs Sally التعليمية وواتساب
// يعتمد على مكتبة whatsapp-web.js (تشغّل واتساب ويب حقيقي عن طريق متصفح مخفي)
// ============================================================

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const webpush = require('web-push');
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
// إعداد إشعارات Push الحقيقية (Web Push + VAPID)
// ------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:no-reply@sally-platform.local',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
} else {
    console.warn('تنبيه: مفاتيح VAPID غير مُعرّفة، خاصية Push لن تعمل حتى تضيفيها في Variables');
}

// ------------------------------------------------------------
// حالة الاتصال بواتساب
// ------------------------------------------------------------
let latestQr = null;      // آخر QR كود (Data URL) لسه محتاج مسح
let isReady = false;      // هل واتساب متصل وجاهز للإرسال
let statusText = 'starting'; // starting | qr | authenticated | ready | disconnected

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/data/wwebjs_auth' }),
    // بنزوّد المهلة اللي بيستنّاها Puppeteer قبل ما يعتبر إن الأمر فشل.
    // القيمة الافتراضية (180 ثانية) أحيانًا مش كفاية لو السيرفر شغال على موارد قليلة.
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        protocolTimeout: 300000, // 5 دقايق بدل الافتراضي
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--single-process',   // بيقلل استهلاك الرام كتير على سيرفرات الاستضافة المجانية
            '--no-zygote'
        ]
    }
});

// عداد بسيط لعدد مرات الفشل المتتالية في الإرسال
let consecutiveSendFailures = 0;

// دالة بتعيد تشغيل عميل واتساب من الصفر لو الجلسة اتجمدت
async function restartClient(reason) {
    console.log(`جاري إعادة تشغيل الاتصال بواتساب بسبب: ${reason}`);
    try {
        await client.destroy();
    } catch (err) {
        console.error('خطأ أثناء إغلاق العميل القديم:', err.message);
    }
    isReady = false;
    statusText = 'restarting';
    latestQr = null;
    consecutiveSendFailures = 0;
    client.initialize();
}

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
        consecutiveSendFailures = 0;
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);

        // لو الخطأ نوعه "تايم آوت" فده علامة إن Chromium اتجمد جوه —
        // بعد 3 فشلات متتالية بنعمل إعادة تشغيل تلقائية للعميل
        const isTimeout = /timed out|timeout/i.test(error.message || '');
        if (isTimeout) {
            consecutiveSendFailures += 1;
            if (consecutiveSendFailures >= 3) {
                restartClient('تكرار خطأ التايم آوت في الإرسال');
            }
        }

        res.status(500).json({
            error: isTimeout
                ? 'حصل تأخير في الاتصال بواتساب، جاري إعادة المحاولة تلقائيًا. حاولي تاني بعد شوية.'
                : error.message
        });
    }
});

// نقطة يدوية لإعادة تشغيل الاتصال لو الحالة عالقة (مفيدة للتشخيص)
app.post('/restart', checkApiKey, async (req, res) => {
    await restartClient('طلب يدوي');
    res.json({ success: true, message: 'جاري إعادة التشغيل...' });
});

app.get('/', (req, res) => {
    res.send('Sally WhatsApp Bridge is running ✅');
});

// ------------------------------------------------------------
// إشعارات Push الحقيقية (تعمل حتى لو الموقع مقفول تمامًا)
// ------------------------------------------------------------

// إرجاع المفتاح العام حتى يقدر المتصفح يعمل اشتراك Push
app.get('/vapid-public-key', checkApiKey, (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(500).json({ error: 'مفاتيح VAPID غير مُعرّفة على السيرفر' });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// إرسال إشعار Push فعلي لاشتراك معيّن
// body: { subscription: {...}, title: "...", body: "..." }
app.post('/send-push', checkApiKey, async (req, res) => {
    try {
        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
            return res.status(500).json({ error: 'مفاتيح VAPID غير مُعرّفة على السيرفر' });
        }
        const { subscription, title, body } = req.body;
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ error: 'بيانات الاشتراك (subscription) غير صحيحة' });
        }
        await webpush.sendNotification(
            subscription,
            JSON.stringify({ title: title || 'إشعار جديد', body: body || '' })
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending push notification:', error);
        // كود 410 يعني الاشتراك بايظ/منتهي، مفيد للفرونت إند حتى يمسحه
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`السيرفر شغال على البورت ${PORT}`);
});
