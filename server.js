// ============================================================
// سيرفر وسيط بين منصة Mrs Sally التعليمية وواتساب
// يعتمد على مكتبة whatsapp-web.js
// ============================================================

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const webpush = require('web-push');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------
// مفتاح أمان اختياري
// ------------------------------------------------------------
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
let statusText = 'starting';
let consecutiveSendFailures = 0;

let client = null;
let authTimeout = null;
let isCreating = false;
let recreateTimer = null;

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || '/tmp/wwebjs_auth';

// ------------------------------------------------------------
// أداة مساعدة: تجاهل الأخطاء المزعجة وقت الإغلاق
// ------------------------------------------------------------
function isHarmlessError(err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    return (
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('Protocol error') ||
        msg.includes('Execution context was destroyed')
    );
}

// ------------------------------------------------------------
// جدولة إنشاء عميل جديد (بدل setTimeout مبعثر)
// ------------------------------------------------------------
function scheduleRecreate(delayMs, reason) {
    if (recreateTimer) {
        clearTimeout(recreateTimer);
    }
    console.log(`⏱️ جدولة إعادة إنشاء العميل بعد ${delayMs}ms (${reason})`);
    recreateTimer = setTimeout(() => {
        recreateTimer = null;
        createClient(reason);
    }, delayMs);
}

// ------------------------------------------------------------
// إنشاء عميل واتساب جديد من الصفر
// ------------------------------------------------------------
function createClient(reason = 'unknown') {
    if (isCreating) {
        console.log('createClient: محاولة إنشاء أثناء إنشاء آخر، تجاهل.');
        return;
    }
    isCreating = true;
    console.log(`🔄 إنشاء عميل واتساب جديد (السبب: ${reason})`);

    // تنظيف مؤقت التوثيق
    if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
    }

    const oldClient = client;
    client = null;

    const proceed = () => {
        let newClient;
        try {
            newClient = new Client({
                authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
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
                    ]
                }
            });
        } catch (err) {
            console.error('❌ فشل إنشاء Client:', err.message);
            isCreating = false;
            scheduleRecreate(5000, 'فشل إنشاء Client');
            return;
        }

        client = newClient;

        // QR جديد
        newClient.on('qr', async (qr) => {
            statusText = 'qr';
            isReady = false;
            try {
                latestQr = await QRCode.toDataURL(qr);
                console.log('✅ QR جديد جاهز — افتحي /qr وامسحيه بسرعة');
            } catch (err) {
                console.error('❌ فشل تحويل QR لصورة:', err.message);
            }
        });

        // تم التوثيق — نستنى "ready" خلال 60 ثانية وإلا الجلسة تالفة
        newClient.on('authenticated', () => {
            statusText = 'authenticated';
            isReady = false;
            console.log('🔐 تم التوثيق، جاري التجهيز...');
            if (authTimeout) clearTimeout(authTimeout);
            authTimeout = setTimeout(() => {
                authTimeout = null;
                console.warn('⚠️ الجلسة قديمة/تالفة (ready مجاش)، إعادة إنشاء العميل...');
                createClient('auth timeout');
            }, 60000);
        });

        // جاهز للإرسال
        newClient.on('ready', () => {
            if (authTimeout) {
                clearTimeout(authTimeout);
                authTimeout = null;
            }
            statusText = 'ready';
            isReady = true;
            latestQr = null;
            consecutiveSendFailures = 0;
            isCreating = false; // ✅ العميل بقى جاهز فعلاً
            console.log('✅ واتساب متصل وجاهز للإرسال');
        });

        // انقطع الاتصال
        newClient.on('disconnected', (reason) => {
            if (authTimeout) {
                clearTimeout(authTimeout);
                authTimeout = null;
            }
            statusText = 'disconnected';
            isReady = false;
            latestQr = null;
            isCreating = false; // ✅ نسمح بإعادة الإنشاء
            console.log('🔌 انقطع الاتصال بواتساب:', reason);
            scheduleRecreate(5000, 'disconnected');
        });

        // فشل التوثيق
        newClient.on('auth_failure', (msg) => {
            if (authTimeout) {
                clearTimeout(authTimeout);
                authTimeout = null;
            }
            statusText = 'auth_failure';
            isReady = false;
            latestQr = null;
            isCreating = false; // ✅
            console.error('❌ فشل التوثيق:', msg);
            scheduleRecreate(5000, 'auth_failure');
        });

        // خطأ عام — نتجاهل المزعج وقت الإغلاق
        newClient.on('error', (err) => {
            if (isHarmlessError(err)) return;
            console.error('⚠️ خطأ في عميل واتساب:', err && err.message ? err.message : err);
        });

        // التهيئة
        newClient.initialize()
            .then(() => {
                console.log('🚀 initialize() خلص');
                // ملاحظة: مش بنصفّر isCreating هنا
                // لأن ready / disconnected / auth_failure هما اللي بيصفّروها
            })
            .catch((err) => {
                if (!isHarmlessError(err)) {
                    console.error('❌ فشل initialize:', err.message);
                }
                statusText = 'disconnected';
                isReady = false;
                isCreating = false;
                scheduleRecreate(5000, 'initialize failed');
            });
    };

    if (oldClient) {
        try {
            oldClient.removeAllListeners();
        } catch (_) {}

        oldClient.destroy()
            .catch((err) => {
                if (!isHarmlessError(err)) {
                    console.error('خطأ أثناء destroy:', err.message);
                }
            })
            .finally(() => {
                // نستنى 3 ثواني عشان الـ Puppeteer process يموت فعلاً
                setTimeout(proceed, 3000);
            });
    } else {
        proceed();
    }
}

// ------------------------------------------------------------
// إعادة تشغيل يدوية
// ------------------------------------------------------------
function restartClient(reason) {
    console.log(`♻️ إعادة تشغيل الاتصال بواتساب بسبب: ${reason}`);
    isReady = false;
    statusText = 'restarting';
    latestQr = null;
    consecutiveSendFailures = 0;
    // نلغي أي جدولة سابقة
    if (recreateTimer) {
        clearTimeout(recreateTimer);
        recreateTimer = null;
    }
    // نصفّر isCreating عشان نقدر نعمل عميل جديد
    isCreating = false;
    createClient(reason);
}

// التشغيل الأول
createClient('initial start');

// ------------------------------------------------------------
// المسارات (Endpoints)
// ------------------------------------------------------------

app.get('/status', checkApiKey, (req, res) => {
    res.json({ connected: isReady, status: statusText });
});

app.get('/qr', checkApiKey, (req, res) => {
    res.json({ qr: latestQr, status: statusText });
});

// تسجيل الخروج
app.post('/logout', checkApiKey, async (req, res) => {
    try {
        if (!client) {
            createClient('logout بدون عميل');
            return res.json({ success: true, message: 'تم إنشاء عميل جديد' });
        }
        await client.logout();
        // disconnected هيتعامل مع الباقي
        res.json({ success: true });
    } catch (error) {
        if (!isHarmlessError(error)) {
            console.error('خطأ في logout:', error.message);
        }
        // حتى لو فشل، نحاول نعمل عميل جديد
        scheduleRecreate(3000, 'logout failed');
        res.status(500).json({ error: error.message });
    }
});

// إرسال رسالة
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

// إعادة تشغيل يدوية
app.post('/restart', checkApiKey, async (req, res) => {
    restartClient('طلب يدوي');
    res.json({ success: true, message: 'جاري إعادة التشغيل...' });
});

app.get('/', (req, res) => {
    res.send('Sally WhatsApp Bridge is running ✅');
});

// ------------------------------------------------------------
// إشعارات Push
// ------------------------------------------------------------

app.get('/vapid-public-key', checkApiKey, (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(500).json({ error: 'مفاتيح VAPID غير مُعرّفة على السيرفر' });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

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
    console.log(`🌐 السيرفر شغال على البورت ${PORT}`);
    console.log(`📁 مسار الجلسة: ${AUTH_PATH}`);
});

// تنظيف عند إغلاق العملية
process.on('SIGTERM', async () => {
    console.log('SIGTERM: جاري الإغلاق...');
    if (recreateTimer) clearTimeout(recreateTimer);
    if (authTimeout) clearTimeout(authTimeout);
    try {
        if (client) await client.destroy();
    } catch (_) {}
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    if (isHarmlessError(err)) return;
    console.error('💥 uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason) => {
    if (isHarmlessError(reason)) return;
    console.error('💥 unhandledRejection:', reason && reason.message ? reason.message : reason);
});
