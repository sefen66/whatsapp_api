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

// مفتاح أمان اختياري
const API_KEY = process.env.API_KEY || '';
function checkApiKey(req, res, next) {
    if (!API_KEY) return next();
    const provided = req.header('x-api-key');
    if (provided !== API_KEY) {
        return res.status(401).json({ error: 'مفتاح API غير صحيح' });
    }
    next();
}

// ------------------------------------------------------------
// إعداد إشعارات Push (Web Push + VAPID)
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
// الحالة العامة
// ------------------------------------------------------------
let latestQr = null;
let isReady = false;
let statusText = 'starting'; // starting | qr | authenticated | ready | disconnected | restarting | auth_failure
let consecutiveSendFailures = 0;

// العميل الحالي + مؤقتات ومؤشرات حماية
let client = null;
let authTimeout = null;
let isCreating = false;

// ------------------------------------------------------------
// إنشاء عميل واتساب جديد من الصفر
// ------------------------------------------------------------
function createClient() {
    // حماية ضد التنفيذ المتوازي
    if (isCreating) {
        console.log('createClient: محاولة إنشاء أثناء إنشاء آخر، تجاهل.');
        return;
    }
    isCreating = true;

    // تنظيف العميل القديم
    const oldClient = client;
    client = null;

    const proceed = () => {
        console.log('إنشاء عميل واتساب جديد...');
        client = new Client({
            authStrategy: new LocalAuth({ dataPath: '/data/wwebjs_auth' }),
            puppeteer: {
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                protocolTimeout: 300000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions'
                    // '--single-process' // لو الرام ضيقة جدًا، جرّبي تفعيلها (بس ممكن تكسر الإرسال)
                ]
            }
        });

        // QR جديد
        client.on('qr', async (qr) => {
            statusText = 'qr';
            isReady = false;
            try {
                latestQr = await QRCode.toDataURL(qr);
                console.log('QR جديد جاهز ✅');
            } catch (err) {
                console.error('فشل تحويل QR لصورة:', err.message);
            }
        });

        // تم التوثيق — نستنى "ready" خلال 30 ثانية وإلا الجلسة تالفة
        client.on('authenticated', () => {
            statusText = 'authenticated';
            isReady = false;
            console.log('تم التوثيق، جاري التجهيز...');
            clearTimeout(authTimeout);
            authTimeout = setTimeout(() => {
                console.warn('⚠️ الجلسة قديمة/تالفة (ready مجاش)، إعادة إنشاء العميل...');
                createClient();
            }, 30000);
        });

        // جاهز للإرسال
        client.on('ready', () => {
            clearTimeout(authTimeout);
            authTimeout = null;
            statusText = 'ready';
            isReady = true;
            latestQr = null;
            consecutiveSendFailures = 0;
            console.log('واتساب متصل وجاهز للإرسال ✅');
        });

        // انقطع الاتصال — ننشئ عميل جديد بعد 5 ثواني
        client.on('disconnected', (reason) => {
            clearTimeout(authTimeout);
            authTimeout = null;
            statusText = 'disconnected';
            isReady = false;
            latestQr = null;
            console.log('انقطع الاتصال بواتساب:', reason);
            setTimeout(() => createClient(), 5000);
        });

        // فشل التوثيق — ننشئ عميل جديد بعد 5 ثواني
        client.on('auth_failure', (msg) => {
            clearTimeout(authTimeout);
            authTimeout = null;
            statusText = 'auth_failure';
            isReady = false;
            latestQr = null;
            console.error('فشل التوثيق:', msg);
            setTimeout(() => createClient(), 5000);
        });

        // أي خطأ عام في العميل
        client.on('error', (err) => {
            console.error('خطأ في عميل واتساب:', err && err.message ? err.message : err);
        });

        // التهيئة الفعلية
        client.initialize().catch((err) => {
            console.error('فشل initialize:', err.message);
            statusText = 'disconnected';
            isReady = false;
            setTimeout(() => createClient(), 5000);
        });

        isCreating = false;
    };

    if (oldClient) {
        try {
            oldClient.removeAllListeners();
        } catch (_) {}
        oldClient.destroy()
            .catch((err) => console.error('خطأ أثناء destroy:', err.message))
            .finally(() => {
                // نستنى شوي عشان الـ Puppeteer process يموت فعلاً قبل ما نطلع واحد جديد
                setTimeout(proceed, 2000);
            });
    } else {
        proceed();
    }
}

// إعادة تشغيل يدوية
function restartClient(reason) {
    console.log(`إعادة تشغيل الاتصال بواتساب بسبب: ${reason}`);
    isReady = false;
    statusText = 'restarting';
    latestQr = null;
    consecutiveSendFailures = 0;
    createClient();
}

// التشغيل الأول
createClient();

// ------------------------------------------------------------
// المسارات (Endpoints)
// ------------------------------------------------------------

// حالة الاتصال الحالية
app.get('/status', checkApiKey, (req, res) => {
    res.json({ connected: isReady, status: statusText });
});

// آخر QR كود متاح للمسح
app.get('/qr', checkApiKey, (req, res) => {
    res.json({ qr: latestQr, status: statusText });
});

// تسجيل الخروج وإعادة توليد QR جديد
app.post('/logout', checkApiKey, async (req, res) => {
    try {
        if (!client) {
            // مفيش عميل شغال، ننشئ واحد جديد على طول
            createClient();
            return res.json({ success: true, message: 'تم إنشاء عميل جديد' });
        }
        await client.logout();
        // بعد logout، whatsapp-web.js بيطلق disconnected وبنتعامل معاه هناك.
        // بس كضمان إضافي، نعمل createClient() بعد شوي لو لسه ما اتعملش.
        setTimeout(() => {
            if (!isCreating && (!client || !isReady)) {
                createClient();
            }
        }, 3000);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في logout:', error.message);
        // حتى لو فشل logout، نحاول نعمل عميل جديد
        createClient();
        res.status(500).json({ error: error.message });
    }
});

// إرسال رسالة واتساب فعلية
// body: { phone: "201001234567", message: "نص الرسالة" }
app.post('/send-message', checkApiKey, async (req, res) => {
    try {
        if (!isReady || !client) {
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

// نقطة يدوية لإعادة تشغيل الاتصال
app.post('/restart', checkApiKey, async (req, res) => {
    restartClient('طلب يدوي');
    res.json({ success: true, message: 'جاري إعادة التشغيل...' });
});

app.get('/', (req, res) => {
    res.send('Sally WhatsApp Bridge is running ✅');
});

// ------------------------------------------------------------
// إشعارات Push الحقيقية
// ------------------------------------------------------------

// إرجاع المفتاح العام
app.get('/vapid-public-key', checkApiKey, (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(500).json({ error: 'مفاتيح VAPID غير مُعرّفة على السيرفر' });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// إرسال إشعار Push فعلي
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
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// ------------------------------------------------------------
// تشغيل السيرفر
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`السيرفر شغال على البورت ${PORT}`);
});

// تنظيف عند إغلاق العملية (مفيد لـ Railway)
process.on('SIGTERM', async () => {
    console.log('SIGTERM: جاري الإغلاق...');
    try {
        if (client) await client.destroy();
    } catch (_) {}
    process.exit(0);
});
