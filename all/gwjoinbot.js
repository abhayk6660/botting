const axios = require('axios');
const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Ensure GWJOINBOT storage directory exists
const GWJOINBOT_DIR = path.join(__dirname, 'GWJOINBOT');
if (!fs.existsSync(GWJOINBOT_DIR)) {
    fs.mkdirSync(GWJOINBOT_DIR, { recursive: true });
}

// Load environment variables from .env file if it exists
try {
    let dotenvPath = path.join(GWJOINBOT_DIR, '.env');
    if (!fs.existsSync(dotenvPath)) {
        dotenvPath = path.join(__dirname, '.env');
    }
    if (!fs.existsSync(dotenvPath)) {
        dotenvPath = path.join(__dirname, 'env');
    }
    if (fs.existsSync(dotenvPath)) {
        const dotenvContent = fs.readFileSync(dotenvPath, 'utf8');
        dotenvContent.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const parts = trimmed.split('=');
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                process.env[key] = value;
            }
        });
    }
} catch (e) {
    console.error("Warning: Failed to load .env file:", e.message);
}

// ==== CONFIGURATION & ACCOUNTS ==== //
const rawTokens = process.env.DISCORD_TOKENS || process.env.DISCORD_TOKEN || "";
const TOKENS = rawTokens
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

const ACCOUNTS = [];
const configuredTokens = [...TOKENS];

configuredTokens.forEach(tok => {
    ACCOUNTS.push({
        token: tok,
        username: '',
        userId: '',
        ws: null,
        connectionState: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
        intentionalClose: false,
        reconnectTimer: null,
        heartbeatTimer: null,
        presenceTimer: null,
        lastHeartbeatAck: true,
        reactedMessages: new Set(),
        processedWinningMessages: new Set(),
        attendanceDecisions: new Map(),
        minReactDelay: parseInt(process.env.MIN_REACTION_DELAY, 10) || 3000,
        maxReactDelay: parseInt(process.env.MAX_REACTION_DELAY, 10) || 4000,
        minReplyDelay: 7500,
        maxReplyDelay: 16000,
        lastWordCopyTime: 0,
        wordCopyProbability: 0.05,
        wordCopyCooldown: 240000,
        triviaWinStreak: 0,
        triviaWinStreakThreshold: 2 + Math.floor(Math.random() * 2), // 2 to 3 wins maximum
        triviaSkipCount: 0,
        didGuessThisGame: false,
        lastTriviaGuessTime: 0,
        lastTriviaGuess: '',
        consecutiveReactions: 0,
        reactionLimitBeforeMessage: 5 + Math.floor(Math.random() * 4) // 5 to 8 reactions
    });
});

console.log(`🔑 Loaded ${ACCOUNTS.length} account token(s).`);
ACCOUNTS.forEach((acc, idx) => {
    const masked = acc.token.length > 10
        ? `${acc.token.slice(0, 6)}...${acc.token.slice(-4)}`
        : '***';
    console.log(`   Account [${idx + 1}]: ${masked}`);
});

const CONFIGS = [
    {
        name: 'Z23 Guild',
        guildId: '1184110194905600132',
        channelId: '1213975152145072128',
        customEmoji: '<a:Z23:1298856059817168996>',
        targetBotId: '1344240724526235759',
        targetPhrases: ["Enabled /Giveaway Auto", "enter by reacting", "giveaway"]
    }
];

const VOICE_CHANNELS = [
    {
        guildId: '1184110194905600132',
        channelId: '1503770103177678989'
    }
];

const MIN_REACTION_DELAY = parseInt(process.env.MIN_REACTION_DELAY, 10) || 3000;
const MAX_REACTION_DELAY = parseInt(process.env.MAX_REACTION_DELAY, 10) || 4000;

const MIN_TRIVIA_DELAY = parseInt(process.env.MIN_TRIVIA_DELAY, 10) || 3500;
const MAX_TRIVIA_DELAY = parseInt(process.env.MAX_TRIVIA_DELAY, 10) || 6500;

const TRIVIA_MIN_PEOPLE = 0; // minimum unique guessers to wait for before answering
const TRIVIA_MAX_PEOPLE = 0; // 0 to answer instantly
const TRIVIA_MAX_WAIT_MS = 0; // 0ms wait delay

// ==== RENDER WEB / HEALTH CHECK SERVER ==== //
// Render Web Services require an active HTTP listener on process.env.PORT
const PORT = process.env.PORT || 10000;
try {
    const webServer = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/health' || req.url === '/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'online',
                bot: 'gw-join-bot',
                accountsConfigured: ACCOUNTS.length,
                accountsConnected: ACCOUNTS.filter(a => a.connectionState === 'connected').length,
                uptimeSeconds: Math.floor(process.uptime()),
                timestamp: new Date().toISOString()
            }, null, 2));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    webServer.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 [Render/Web] Health-check HTTP server listening on 0.0.0.0:${PORT}`);
    });

    webServer.on('error', (err) => {
        console.error('⚠️ [Web Server Error]:', err.message);
    });
} catch (e) {
    console.error('⚠️ Could not start HTTP server:', e.message);
}

// Browser fingerprinting & TLS spoofing
const SUPER_PROPERTIES = {
    os: 'Windows',
    browser: 'Chrome',
    device: '',
    system_locale: 'en-US',
    browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    browser_version: '131.0.0.0',
    os_version: '10',
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: 350500,
    client_event_source: null
};

const SUPER_PROPERTIES_BASE64 = Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64');

const httpsAgent = new https.Agent({
    ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-RSA-AES128-SHA',
        'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256',
        'AES256-GCM-SHA384',
        'AES128-SHA',
        'AES256-SHA'
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    keepAlive: true
});

const discord = axios.create({
    baseURL: `https://discord.com/api/v10`,
    httpsAgent,
    headers: {
        'Content-Type': 'application/json',
        'User-Agent': SUPER_PROPERTIES.browser_user_agent,
        'X-Super-Properties': SUPER_PROPERTIES_BASE64,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
        'X-Debug-Options': 'bugReporterEnabled'
    }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==== BOUNDED MEMORY HELPERS ==== //
function pruneBoundedMap(map, maxSize = 500) {
    if (map.size > maxSize) {
        const excess = map.size - maxSize;
        const iter = map.keys();
        for (let i = 0; i < excess; i++) {
            map.delete(iter.next().value);
        }
    }
}

function pruneBoundedSet(set, maxSize = 500) {
    if (set.size > maxSize) {
        const excess = set.size - maxSize;
        const iter = set.values();
        for (let i = 0; i < excess; i++) {
            set.delete(iter.next().value);
        }
    }
}

// ==== GLOBAL STATE & TRACKING ==== //
const globalAlertedMessages = new Set();
const globalGiveawayReplies = new Map(); // msgId -> Set of chosen phrases
const userLastReplyTimes = new Map(); // key: accountUserId + msgAuthorId -> timestamp
const sentMessagesMap = new Map(); // key: messageId -> bot's message content
const globalGiveawayReactors = new Map(); // msgId -> chosenAccountUserId
const global100MDecisionMap = new Map(); // msgId -> shouldChat (boolean)
let globalLastGiveawayChatTime = 0;
let globalLastTriviaSoonTime = 0;
let globalLastTriviaEndTime = 0;
let globalSecurityPauseUntil = 0;
const globalTriviaSoonChats = new Set();
const lastLogTimes = new Map();

const BLOCKED_PHRASES_FILE = path.join(GWJOINBOT_DIR, 'blocked_phrases.json');
const TRIVIA_HISTORY_FILE = path.join(GWJOINBOT_DIR, 'trivia_history.json');
const blockedPhrases = new Set();

const TRAP_KEYWORDS = [
    'trap', 'bot check', 'bot test', 'ban', 'banned', 'do not react',
    'dont react', 'don\'t react', 'fake', 'test', 'captcha', 'staff check',
    'mod check', 'disqualif', 'penalty', 'warning', 'gotcha', 'do not enter',
    'dont enter', 'don\'t enter', 'no react', 'ban test', 'bait', 'react for ban',
    'react = ban', 'reacting = ban', 'react=ban', 'afk check'
];

function isTrapMessage(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return TRAP_KEYWORDS.some(keyword => lower.includes(keyword));
}

async function sendUrgentModAlert(account, msg, reason = "Staff / Mod Mention or Accusation") {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL || "";
    if (!webhookUrl || !webhookUrl.startsWith("http")) {
        console.warn("⚠️ ALERT_WEBHOOK_URL not configured. Skipping alert webhook dispatch.");
        return;
    }
    const displayedContent = msg.content || msg.embeds?.[0]?.description || msg.embeds?.[0]?.title || '(no content)';
    const payload = {
        username: "Anti-Detect Security Alert",
        content: `🚨 **URGENT SECURITY ALERT!** 🚨\n**Reason**: ${reason}\n**Account**: @${account.username || 'unknown'} (${account.userId})\n**Trigger Author**: @${msg.author ? msg.author.username : 'unknown'} (${msg.author ? msg.author.id : 'N/A'})\n**Channel**: <#${msg.channel_id}>\n**Message Content**:\n> ${displayedContent}\n\n⚠️ *Automated chatting paused for 20 minutes in this channel so you can handle manually.*`
    };
    try {
        await axios.post(webhookUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        console.log(`🔔 Dispatched emergency alert webhook for @${account.username}!`);
    } catch (e) {
        console.error(`❌ Failed to send emergency webhook:`, e.message);
    }
}

function loadBlockedPhrases() {
    try {
        if (fs.existsSync(BLOCKED_PHRASES_FILE)) {
            const data = fs.readFileSync(BLOCKED_PHRASES_FILE, 'utf8');
            const list = JSON.parse(data);
            if (Array.isArray(list)) {
                list.forEach(p => blockedPhrases.add(p.toLowerCase().trim()));
                console.log(`📋 Loaded ${blockedPhrases.size} blocked phrases from persistent storage.`);
            }
        }
    } catch (err) {
        console.error("❌ Failed to load blocked phrases:", err.message);
    }
}

async function saveBlockedPhrases() {
    try {
        const list = Array.from(blockedPhrases);
        await fs.promises.writeFile(BLOCKED_PHRASES_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
        console.error("❌ Failed to save blocked phrases:", err.message);
    }
}

loadBlockedPhrases();

const DICTIONARY_FILE = path.join(__dirname, 'dictionary.json');
const dictionaryWords = new Set();

function loadDictionary() {
    try {
        if (fs.existsSync(DICTIONARY_FILE)) {
            const data = fs.readFileSync(DICTIONARY_FILE, 'utf8');
            const list = JSON.parse(data);
            if (Array.isArray(list)) {
                list.forEach(w => dictionaryWords.add(w.toLowerCase().trim()));
                console.log(`📋 Loaded ${dictionaryWords.size} words from dictionary.json for spellchecking.`);
            }
        } else {
            console.warn("⚠️ dictionary.json not found. Spellchecking will be disabled.");
        }
    } catch (err) {
        console.error("❌ Failed to load dictionary.json:", err.message);
    }
}
loadDictionary();

const ALLOWED_SLANG = new Set([
    'lol', 'fr', 'tbh', 'ngl', 'lmao', 'lmfao', 'bruh', 'sheesh', 'wat', 'yap', 'yep', 'ye', 'yeah', 'nah',
    'ok', 'okay', 'yall', 'gg', 'ggs', 'wp', 'gl', 'glgl', 'ty', 'tyty', 'tysm', 'pls', 'plz',
    'gamba', 'exp', 'level', 'grind', 'grinding', 'bot', 'drop', 'claim', 'giveaway', 'win',
    'winner', 'winners', 'hype', 'dead', 'alive', 'scared', 'sad', 'happy', 'blue', 'red',
    'green', 'gold', 'rng', 'chat', 'active', 'wanna', 'gonna', 'im', 'dont', 'cant', 'thats',
    'its', 'ive', 'youre', 'idk', 'omg', 'wtf', 'bro', 'yoo', 'wat', 'ur', 'w', 'l', 'vibe', 'vibing',
    'sneep', 'snipe', 'sniped', 'macro', 'mod', 'admin', 'server', 'ping', 'crying', 'cooldown'
]);

function hasWrongSpellings(text) {
    if (!text || dictionaryWords.size === 0) return false;
    const words = text.split(/\s+/);
    for (let word of words) {
        const clean = word.toLowerCase().trim().replace(/[^a-z]/g, '');
        if (clean.length < 4) continue;
        if (ALLOWED_SLANG.has(clean)) continue;
        if (!dictionaryWords.has(clean)) {
            return true;
        }
    }
    return false;
}

// ==== VOCABULARIES & PHRASES PACK ==== //
const RAW_GL_PHRASES = [
    "hopefully me", "im winning", "need this win", "ok im in", "let me cook",
    "lets see", "hoping for this", "i pray", "worthit", "im ready",
    "gl everyone", "luck is with me", "maybe today", "why not", "might get lucky",
    "i can hope", "winning it", "lets gamble", "this is huge", "pls rng gid",
    "surely this one", "it hurts", "here it is", "ill win", "feeling lucky on this",
    "surely i win this", "it could happen", "lets test my luck", "another attempt",
    "we ball", "cant hurt", "im feeling it", "please be me", "this is the one",
    "its my turn", "need the miracle", "worth the click", "we'll see what happens",
    "sending prayers", "here goes nothing", "all or nothing", "come on luck",
    "lets gooo", "i believe", "today maybe", "surely surely", "dont fail me now",
    "im coping", "blessing incoming", "please rng", "wish me luck",
    "small dihh big dreams", "ill believe", "ive got hope", "its possible",
    "lets find out", "trying again", "another gw another try", "still hoping",
    "never giving up", "would be nice fr"
];

const HUMAN_TOPIC_PHRASES = {
    waiting: [
        "wonder who gets it", "lets see then", "still waiting", "guess we'll know soon",
        "not long now", "any second now", "almost time", "lets find out", "curious honestly",
        "guess its close", "wonder how long", "we'll see soon", "waiting patiently",
        "soon hopefully", "still waiting lol", "clock is ticking", "taking forever",
        "soon maybe", "almost there", "getting closer", "waiting game", "guess we wait",
        "lets be patient", "im curious now", "who knows", "wondering", "cant wait",
        "we wait", "its close i think", "few more seconds", "any moment now",
        "still nothing", "waiting continues", "time will tell"
    ],
    winner: [
        "imagine winning though", "someone got lucky", "whoever wins gg",
        "someone eating good today", "someone called it", "someone deserves it",
        "lucky timing fr", "someone is happy", "gg already", "calling it now",
        "lets see who gets it"
    ],
    timing: [
        "perfect timing", "good timing though", "barely made it in", "just got here",
        "almost missed it", "right on time", "timing is crazy", "made it barely",
        "just in time", "almost forgot", "nice timing", "well timed"
    ],
    reactions: [
        "didnt expect that", "thats interesting", "well then", "fair enough",
        "not complaining", "cant argue with that", "ill take it", "honestly fair",
        "works for me", "sounds alright", "good enough", "thats decent",
        "pretty solid", "makes sense", "understandable", "respect it", "valid",
        "fair", "real honestly", "thats clean", "solid", "respect", "cant complain",
        "interesting tbh", "thats fair", "i see it", "understood", "good point",
        "facts", "lowkey true", "highkey true", "thats wild", "crazy honestly",
        "well played", "not bad", "thats nice", "decent enough", "pretty cool",
        "i rate it", "fair play", "reasonable", "understandable honestly",
        "makes sense tbh", "true enough", "im with you", "honestly yeah", "chill vibes"
    ],
    lurking: [
        "just chilling", "im here", "still around", "chilling as usual",
        "vibing", "just lurkin", "watching chat"
    ],
    jokes: [
        "watch me lose lol", "classic timing", "not again", "cant make this up",
        "already over?", "thats rough", "im cooked", "guess not today",
        "here we go", "thats unlucky", "could be worse", "its over for me",
        "im finished", "im doomed", "not my day", "maybe next time",
        "another loss incoming", "i can feel it", "watch me miss again",
        "the streak continues", "i already know", "its joever", "pain",
        "im cooked fr", "rip me", "there goes my luck", "we try again",
        "thats life", "it is what it is", "cant win them all", "back to grinding",
        "thats crazy"
    ]
};

const CONGRATS_PHRASES = [...HUMAN_TOPIC_PHRASES.winner];
const RANDOM_PHRASES = [
    ...HUMAN_TOPIC_PHRASES.lurking,
    ...HUMAN_TOPIC_PHRASES.jokes,
    ...HUMAN_TOPIC_PHRASES.reactions,
    ...HUMAN_TOPIC_PHRASES.timing
];

const GL_PHRASES = [
    ...RAW_GL_PHRASES,
    ...HUMAN_TOPIC_PHRASES.waiting
];

// Clean prohibited phrases
const isProhibited = p => {
    const l = p.toLowerCase();
    const words = l.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''));
    return l.includes("free stuff") ||
        l.includes("spawn") ||
        l.includes("appeared instantly") ||
        l.includes("notification") ||
        l.includes("overtime") ||
        l.includes("woke up") ||
        l.includes("everyone appeared") ||
        words.includes("rng") ||
        words.includes("chat") ||
        words.includes("active");
};

const cleanedGL = GL_PHRASES.filter(p => !isProhibited(p));
GL_PHRASES.length = 0;
GL_PHRASES.push(...cleanedGL);

const cleanedRandom = RANDOM_PHRASES.filter(p => !isProhibited(p));
RANDOM_PHRASES.length = 0;
RANDOM_PHRASES.push(...cleanedRandom);

const APPROPRIATE_PHRASES = [
    "real", "fr", "true", "tbh yeah", "makes sense", "fair enough",
    "honestly real", "fr though", "yeah same", "i agree tbh",
    "definitely true", "based", "no lies detected"
];

const ACCUSATION_REPLIES = [
    "no lol", "no", "nah", "no im here", "no im not lol",
    "nah im actually here", "no? lol im here", "im here wtf",
    "no im literally here lol", "bro what? im here", "im here",
    "not botting, im here lol", "no?", "im here lol", "no im actually here",
    "bro im here", "bruh im here", "why would i be botting, im literally here lol",
    "nah im just chilling here"
];

const SNIPE_REPLIES = [
    "hehe", "lol", "hehe lol", "lol ty", "hehe ty",
    "hehe thanks", "lol thanks", "hehe sneep"
];

const NICE_GUESS_REPLIES = [
    "thankyou", "thankuu", "thanku", "tyty", "thank you",
    "ty", "thanks", "tysm", "ty!"
];

// Trivia constants
const TRIVIA_RANKS = ['member', 'ethereal', 'luminary', 'radiant', 'catalyst', 'divine', 'cosmic'];
const TRIVIA_COLORS = ['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black', 'white', 'brown', 'grey', 'gray'];
const TRIVIA_ANIMALS = ['bear', 'tiger', 'lion', 'cat', 'dog', 'chicken', 'panda', 'pig', 'deer', 'mouse', 'cow', 'sheep', 'rabbit', 'monkey'];
const TRIVIA_FOOD = ['taco', 'burger', 'pizza', 'fries', 'donut', 'ice cream', 'icecream', 'hot dog', 'hotdog', 'cake'];
const TRIVIA_FRUIT = ['apple', 'banana', 'kiwi', 'orange', 'grape', 'strawberry', 'pear', 'peach', 'mango', 'watermelon', 'cherry', 'pineapple', 'lemon', 'melon'];
const TRIVIA_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

const activeTriviaGames = new Map(); // channelId -> { gameId, isCancelled, startTime, endTime, gameType, typedAnswers, guesserIds }

function consoleLogUnique(msg, isWarn = false) {
    const now = Date.now();
    const lastTime = lastLogTimes.get(msg) || 0;
    if (now - lastTime < 30000) {
        return;
    }
    lastLogTimes.set(msg, now);
    pruneBoundedMap(lastLogTimes, 300);
    if (isWarn) {
        console.warn(msg);
    } else {
        console.log(msg);
    }
}

// Channel message history
const channelHistories = new Map();
function updateChannelHistory(msg) {
    if (!msg.author) return;
    const channelId = msg.channel_id;
    if (!channelHistories.has(channelId)) {
        channelHistories.set(channelId, []);
    }
    const history = channelHistories.get(channelId);
    history.push({
        authorId: msg.author.id,
        authorUsername: msg.author.username || 'unknown',
        content: msg.content || '',
        messageId: msg.id,
        timestamp: Date.now()
    });
    if (history.length > 50) {
        history.shift();
    }
}

function getPhraseFromHistory(channelId) {
    // Disabled by user preference
    return null;
}

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const recentSentPhrases = [];
const MAX_RECENT_PHRASES = 120;
const phraseLastSentTime = new Map();
const vibeLastSentTime = new Map();
const lastChannelChatTimes = new Map();
const lastNormalChatTime = new Map();
let lastGlobalTypoTime = 0;

function addRecentPhrase(phrase) {
    if (!phrase) return;
    const normalized = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
    const index = recentSentPhrases.indexOf(normalized);
    if (index !== -1) {
        recentSentPhrases.splice(index, 1);
    }
    recentSentPhrases.push(normalized);
    if (recentSentPhrases.length > MAX_RECENT_PHRASES) {
        recentSentPhrases.shift();
    }
}

function registerPhraseCooldown(phrase) {
    if (!phrase) return;
    const normalized = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
    addRecentPhrase(normalized);
    phraseLastSentTime.set(normalized, Date.now());
    pruneBoundedMap(phraseLastSentTime, 500);
    recordPhraseWords(phrase);

    const vibes = getPhraseVibes(phrase);
    for (const vibe of vibes) {
        vibeLastSentTime.set(vibe, Date.now());
    }
    pruneBoundedMap(vibeLastSentTime, 100);
}

const TYPO_EXCLUDE_WORDS = new Set([
    'lmao', 'lmfao', 'lol', 'glgl', 'gl', 'gg', 'ggs', 'wait', 'what', 'chat', 'bruh',
    'oof', 'tbh', 'ngl', 'yall', 'guys', 'them', 'they', 'hope', 'nice', 'win', 'winners',
    'winner', 'here', 'yeah', 'good', 'luck', 'guys', 'true', 'same', 'wanna', 'gonna'
]);

const STOP_WORDS = new Set([
    'the', 'and', 'but', 'for', 'with', 'that', 'this', 'have', 'from',
    'they', 'will', 'would', 'their', 'there', 'about', 'which', 'when',
    'what', 'who', 'how', 'where', 'why', 'been', 'were', 'was', 'are',
    'you', 'your', 'them', 'their', 'some', 'than', 'then', 'here', 'more',
    'to', 'on', 'a', 'i', 'of', 'in', 'it', 'is', 'an', 'at', 'by', 'my',
    'me', 'us', 'we', 'he', 'she', 'they', 'our', 'up', 'down', 'im', 'dont',
    'cant', 'thats', 'its', 'got', 'get', 'not', 'no', 'yes', 'just', 'all',
    'another', 'already'
]);

const UNCOPIABLE_WORDS = new Set([
    'already', 'actually', 'probably', 'someone', 'something', 'anyone', 'anything',
    'everyone', 'everything', 'nobody', 'nothing', 'somewhere', 'anywhere', 'nowhere',
    'everywhere', 'itself', 'himself', 'herself', 'myself', 'yourself', 'yourselves',
    'ourselves', 'themselves', 'another', 'because', 'through', 'during', 'before',
    'behind', 'between', 'against', 'without', 'under', 'until', 'almost', 'always',
    'never', 'sometimes', 'maybe', 'perhaps', 'either', 'neither', 'though', 'although',
    'unless', 'indeed', 'really', 'quite', 'rather', 'somewhat', 'almost', 'hardly',
    'scarcely', 'barely', 'mostly', 'mainly', 'generally', 'especially', 'particularly',
    'entering', 'entered', 'now'
]);

const HIGH_PRIORITY_WORDS = new Set([
    'rank', 'win', 'winfr', 'winner', 'winners', 'drop', 'lucky', 'crazy', 'luck', 'gg',
    'giveaway', 'bot', 'macro', 'mod', 'admin', 'server', 'ping', 'chat', 'scam', 'real',
    'fake', 'legit', 'crying', 'grind', 'grinding', 'fast', 'slow', 'time', 'hour', 'day',
    'hype', 'dead', 'alive', 'scared', 'sad', 'happy', 'blue', 'red', 'green', 'gold',
    'claim', 'claimed', 'manifest', 'manifesting', 'cap', 'wild', 'insane', 'unreal', 'shot'
]);

const wordLastSentTime = new Map();

function getPhraseWords(phrase) {
    if (!phrase) return [];
    return phrase.toLowerCase().trim()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 1);
}

function hasRecentWords(phrase) {
    const words = getPhraseWords(phrase);
    const now = Date.now();
    for (const word of words) {
        if (STOP_WORDS.has(word)) continue;
        if (word.match(/^\d+$/) || word === "100m" || word === "100mil" || word === "1b" || word === "1bil" || word === "1billion") {
            continue;
        }
        const lastSent = wordLastSentTime.get(word) || 0;
        if (now - lastSent < 3600000) { // 1 hour cooldown
            return true;
        }
    }
    return false;
}

function recordPhraseWords(phrase) {
    const words = getPhraseWords(phrase);
    const now = Date.now();
    for (const word of words) {
        if (STOP_WORDS.has(word)) continue;
        if (word.match(/^\d+$/) || word === "100m" || word === "100mil" || word === "1b" || word === "1bil" || word === "1billion") {
            continue;
        }
        wordLastSentTime.set(word, now);
    }
    pruneBoundedMap(wordLastSentTime, 1000);
}

function getWordStem(word) {
    const w = word.toLowerCase().trim().replace(/[^a-z]/g, '');
    if (w.length <= 1) return "";
    if (w.startsWith('congrat') || w.startsWith('grat')) return 'congrat';
    if (w === 'gg' || w === 'ggs' || w === 'wp') return 'gg';
    if (w.startsWith('win') || w === 'won') return 'win';
    if (w.startsWith('luck')) return 'luck';
    if (w.startsWith('hope')) return 'hope';
    if (w.startsWith('manifest')) return 'manifest';
    if (w.startsWith('react')) return 'react';
    if (w.startsWith('enter') || w.startsWith('entry')) return 'enter';
    if (w.startsWith('claim')) return 'claim';
    if (w.startsWith('crazy') || w.startsWith('insane') || w.startsWith('wild')) return 'hype';
    return w;
}

const VIBE_GROUPS = [
    { name: "click", keywords: ["click", "react", "join", "register", "done", "sign me up", "in it", "entered"] },
    { name: "timing", keywords: ["timing", "coincidence", "time"] },
    { name: "chat_active", keywords: ["chat", "server", "active", "awake", "alive", "spawned", "appeared", "moving", "thriving", "crowd", "people", "turnout", "gathering", "everyone", "whole"] },
    { name: "arrival", keywords: ["arrived", "here", "checking", "showing", "made it", "missed", "back"] },
    { name: "vibe", keywords: ["vibing", "vibes", "energy", "mood", "atmosphere", "lurking", "watching", "quietly", "observer"] },
    { name: "meta", keywords: ["chapter", "plot", "quest", "event", "timeline", "lore", "character", "loading", "npc", "episode", "journey", "adventure", "mystery"] },
    { name: "agreement", keywords: ["true", "real", "fair", "valid", "solid", "based", "respect", "decent", "makes sense", "you right", "cant argue", "agree", "legit", "accurate", "wrong", "works", "sounds", "looks", "seems", "ok", "point"] },
    { name: "surprise", keywords: ["expect", "wild", "crazy", "happened", "miss", "lost", "confused", "explain", "coincidence", "what", "coincid"] }
];

function getPhraseVibes(phrase) {
    const p = phrase.toLowerCase();
    const vibes = new Set();
    for (const group of VIBE_GROUPS) {
        for (const keyword of group.keywords) {
            if (p.includes(keyword)) {
                vibes.add(group.name);
            }
        }
    }
    return vibes;
}

function isSameType(phrase1, phrase2) {
    const p1 = phrase1.toLowerCase().trim();
    const p2 = phrase2.toLowerCase().trim();

    const words1 = p1.split(/\s+/).map(w => w.replace(/[^a-z]/g, ''));
    const words2 = p2.split(/\s+/).map(w => w.replace(/[^a-z]/g, ''));

    if (words1[0] && words2[0]) {
        const stem1 = getWordStem(words1[0]);
        const stem2 = getWordStem(words2[0]);
        if (stem1 === stem2) {
            const commonStarters = new Set(["gl", "good", "hope", "need", "congrat", "gg", "best", "let", "ready", "damn", "wait", "bro", "yoo", "nah", "ok", "oh", "im", "already", "claim"]);
            if (commonStarters.has(stem1)) {
                return true;
            }
        }
    }

    if (words1.length >= 2 && words2.length >= 2) {
        const stem1_0 = getWordStem(words1[0]);
        const stem1_1 = getWordStem(words1[1]);
        const stem2_0 = getWordStem(words2[0]);
        const stem2_1 = getWordStem(words2[1]);
        if (stem1_0 === stem2_0 && stem1_1 === stem2_1) {
            return true;
        }
    }

    const stems1 = words1.filter(w => !STOP_WORDS.has(w) && w.length > 1).map(w => getWordStem(w)).filter(s => s !== "");
    const stems2 = words2.filter(w => !STOP_WORDS.has(w) && w.length > 1).map(w => getWordStem(w)).filter(s => s !== "");

    for (const stem of stems1) {
        if (stems2.includes(stem)) {
            return true;
        }
    }

    const vibes1 = getPhraseVibes(phrase1);
    const vibes2 = getPhraseVibes(phrase2);
    for (const vibe of vibes1) {
        if (vibes2.has(vibe)) {
            return true;
        }
    }

    return false;
}

function isPhraseValidAndUnique(phrase) {
    if (!phrase) return false;
    const lower = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
    if (blockedPhrases.has(lower)) return false;
    if (recentSentPhrases.includes(lower)) return false;

    const lastSent = phraseLastSentTime.get(lower) || 0;
    if (Date.now() - lastSent < 28800000) return false; // 8 hours

    const vibes = getPhraseVibes(phrase);
    const now = Date.now();
    for (const vibe of vibes) {
        const lastSentVibe = vibeLastSentTime.get(vibe) || 0;
        if (now - lastSentVibe < 180000) { // 3 minutes
            return false;
        }
    }

    const recentSubset = recentSentPhrases.slice(-40);
    for (const recent of recentSubset) {
        if (isSameType(phrase, recent)) {
            return false;
        }
    }

    if (hasRecentWords(phrase)) {
        return false;
    }

    return true;
}

function mutatePhrase(phrase) {
    if (!phrase) return phrase;
    let mutated = phrase.trim();

    // 15% chance to add prefix or suffix slang modifier
    if (Math.random() < 0.15) {
        const modifiers = ["lol", "fr", "tbh", "ngl", "lmao", "bruh", "sheesh", "wait", "wat", "yap"];
        const lower = mutated.toLowerCase();
        const hasModifier = modifiers.some(m => new RegExp(`\\b${m}\\b`).test(lower));
        if (!hasModifier) {
            const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
            if (Math.random() < 0.5) {
                mutated = `${modifier} ${mutated}`;
            } else {
                mutated = `${mutated} ${modifier}`;
            }
        }
    }

    return mutated;
}

function getUniquePhrase(msgId, category) {
    if (!globalGiveawayReplies.has(msgId)) {
        globalGiveawayReplies.set(msgId, new Set());
    }
    const sentSet = globalGiveawayReplies.get(msgId);
    let phrase;
    let attempts = 0;
    let sourceArray = GL_PHRASES;
    if (category === 'congrats' || category === 'winner') sourceArray = CONGRATS_PHRASES;
    else if (category === 'random') sourceArray = RANDOM_PHRASES;
    else if (category === 'timing') sourceArray = HUMAN_TOPIC_PHRASES.timing;
    else if (category === 'reactions') sourceArray = HUMAN_TOPIC_PHRASES.reactions;

    let basePhrase;
    do {
        basePhrase = sourceArray[Math.floor(Math.random() * sourceArray.length)];
        phrase = mutatePhrase(basePhrase);
        attempts++;

        if (attempts >= 150) {
            let fallbackPhrase = "";
            for (let i = 0; i < 50; i++) {
                const candidate = sourceArray[Math.floor(Math.random() * sourceArray.length)];
                if (!blockedPhrases.has(candidate.toLowerCase().trim())) {
                    fallbackPhrase = candidate;
                    break;
                }
            }
            if (!fallbackPhrase) fallbackPhrase = sourceArray[0];

            const modifiers = ["lol", "fr", "tbh", "ngl", "lmao", "bruh", "yap"];
            const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
            phrase = Math.random() < 0.5 ? `${modifier} ${fallbackPhrase}` : `${fallbackPhrase} ${modifier}`;
            basePhrase = fallbackPhrase;
            console.log(`⚠️ [Anti-Repetition fallback] Generated unique mutated phrase: "${phrase}"`);
            break;
        }
    } while (
        sentSet.has(phrase) ||
        sentSet.has("base:" + basePhrase.toLowerCase().trim()) ||
        !isPhraseValidAndUnique(phrase)
    );

    sentSet.add(phrase);
    sentSet.add("base:" + basePhrase.toLowerCase().trim());
    pruneBoundedMap(globalGiveawayReplies, 500);
    registerPhraseCooldown(phrase);
    return phrase;
}

function getUniqueFromList(list, fallbackList = list) {
    let phrase;
    let attempts = 0;
    do {
        const basePhrase = list[Math.floor(Math.random() * list.length)];
        phrase = mutatePhrase(basePhrase);
        attempts++;
        if (attempts >= 150) {
            let fallbackPhrase = "";
            for (let i = 0; i < 50; i++) {
                const candidate = fallbackList[Math.floor(Math.random() * fallbackList.length)];
                if (!blockedPhrases.has(candidate.toLowerCase().trim())) {
                    fallbackPhrase = candidate;
                    break;
                }
            }
            if (!fallbackPhrase) fallbackPhrase = fallbackList[0];

            const modifiers = ["lol", "fr", "tbh", "ngl", "lmao", "bruh", "yap"];
            const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
            phrase = Math.random() < 0.5 ? `${modifier} ${fallbackPhrase}` : `${fallbackPhrase} ${modifier}`;
            break;
        }
    } while (!isPhraseValidAndUnique(phrase));

    registerPhraseCooldown(phrase);
    return phrase;
}

// Global modes & preferences
const myUserId = '1020719329416855682';
const lastMainUserMessageIds = new Map();
let triviaMode = 's'; // Default to slow
let chatMode = 's'; // 's' for single mode, 'm' for multiple mode
let minigameOnly = true; // Default to true

async function askUserPreferences() {
    const envTriviaMode = process.env.TRIVIA_MODE;
    if (envTriviaMode) {
        const cleaned = envTriviaMode.trim().toLowerCase();
        if (cleaned === 'y' || cleaned === 'yes' || cleaned === 'true') {
            triviaMode = 'y';
            console.log('✅ Trivia ENABLED (Fast delay: ~1.5s - 2.2s) from Environment Variable.');
        } else if (cleaned === 'n' || cleaned === 'no' || cleaned === 'false') {
            triviaMode = 'n';
            console.log('❌ Trivia DISABLED from Environment Variable.');
        } else if (cleaned === 's' || cleaned === 'slow') {
            triviaMode = 's';
            console.log('✅ Trivia ENABLED (Natural delay: ~2.0s - 3.0s) from Environment Variable.');
        }
    } else {
        triviaMode = 's';
        console.log('✅ Trivia Mode set to NATURAL DELAY (2.0s - 3.0s) by default.');
    }

    const envChatMode = process.env.CHAT_MODE;
    if (envChatMode) {
        const cleaned = envChatMode.trim().toLowerCase();
        if (cleaned === 's' || cleaned === 'single' || cleaned === 'one') {
            chatMode = 's';
            console.log('✅ Chat mode set to SINGLE from Environment Variable.');
        } else if (cleaned === 'm' || cleaned === 'multiple' || cleaned === 'multi') {
            chatMode = 'm';
            console.log('✅ Chat mode set to MULTIPLE from Environment Variable.');
        }
    } else {
        chatMode = 's';
        console.log('✅ Chat Mode set to SINGLE by default.');
    }

    const envMinigameOnly = process.env.MINIGAME_ONLY;
    if (envMinigameOnly) {
        const cleaned = envMinigameOnly.trim().toLowerCase();
        if (cleaned === 'y' || cleaned === 'yes' || cleaned === 'true') {
            minigameOnly = true;
            console.log('✅ Minigame Only mode ENABLED from Environment Variable.');
        } else if (cleaned === 'n' || cleaned === 'no' || cleaned === 'false') {
            minigameOnly = false;
            console.log('❌ Minigame Only mode DISABLED from Environment Variable.');
        }
    } else {
        minigameOnly = true;
        console.log('✅ Minigame Only mode set to ENABLED by default.');
    }
}

function handleBotCheckSay(account, msg, text) {
    const sayBotRegex1 = /say+\s+(\w+)\s+if\s+(?:you|you're|youre|u|u're|ure)(?:\s+are)?\s+(?:not\s+(?:a\s+)?bot|real)/i;
    const sayBotRegex2 = /(?:if\s+)?(?:you|you're|youre|u|u're|ure)(?:\s+are)?\s+(?:not\s+(?:a\s+)?bot|real)\s+(?:then\s+)?say+\s+(\w+)/i;

    let requestedWord = null;
    const match1 = text.match(sayBotRegex1);
    if (match1) {
        requestedWord = match1[1];
    } else {
        const match2 = text.match(sayBotRegex2);
        if (match2) {
            requestedWord = match2[1];
        }
    }

    if (requestedWord) {
        const responseText = Math.random() < 0.5 ? requestedWord : `${requestedWord} lol`;
        console.log(`🤖 [Bot Check Reply] Detected bot check. Replying with "${responseText}" to @${msg.author ? msg.author.username : 'unknown'}`);
        sendReplyOrMessage(account.token, msg.channel_id, responseText, msg.id, 1000, 2500, true, true).catch(err => {
            console.error(`❌ [Bot Check Reply Error] Failed to reply:`, err.message);
        });
        return true;
    }
    return false;
}

// ==== REST CLIENT WRAPPERS ==== //
async function triggerTyping(token, channelId) {
    try {
        await discord.post(`/channels/${channelId}/typing`, null, { headers: { Authorization: token } });
    } catch (e) { }
}

async function ackMessage(token, channelId, messageId) {
    try {
        await discord.post(`/channels/${channelId}/messages/${messageId}/ack`, { token: null }, { headers: { Authorization: token } });
    } catch (e) { }
}

async function sendReplyOrMessage(token, channelId, content, messageIdToReplyTo = null, minDelay = 1000, maxDelay = 5000, bypassCooldown = false, bypassStagger = false) {
    if (!content) return null;

    let targetReplyId = messageIdToReplyTo;
    if (targetReplyId) {
        await ackMessage(token, channelId, targetReplyId);
    }

    const lowerContentForCheck = content.toLowerCase();
    if (isProhibited(lowerContentForCheck)) {
        consoleLogUnique(`⚠️ [Prohibited Content Block] Skipping sending message "${content}".`, true);
        return null;
    }

    const activeGame = activeTriviaGames.get(channelId);
    if (activeGame && !activeGame.isCancelled) {
        console.log(`🛡️ [Trivia is ON] Blocking non-trivia message/reply: "${content}"`);
        return null;
    }

    const now = Date.now();
    const lastTime = lastNormalChatTime.get(channelId) || 0;
    const normalCooldown = 300000 + Math.random() * 180000; // 5 to 8 min

    let messageToSend = content;
    let isSkipped = false;
    let skipReason = "";

    if (!bypassCooldown && (now - lastTime < normalCooldown)) {
        isSkipped = true;
        skipReason = `recently chatted in channel within cooldown`;
    } else if (!bypassCooldown && content.trim().length < 4) {
        isSkipped = true;
        skipReason = "message is under 4 characters";
    } else {
        const hasBlocked = Array.from(blockedPhrases).some(p => {
            const cleanBlocked = p.toLowerCase().trim();
            return cleanBlocked && (lowerContentForCheck === cleanBlocked || lowerContentForCheck.includes(cleanBlocked));
        });
        if (hasBlocked) {
            isSkipped = true;
            skipReason = "contains a blocked phrase";
        }
    }

    if (isSkipped) {
        const safePhrase = getUniquePhrase(targetReplyId || 'safe', 'random');
        consoleLogUnique(`🛡️ [Safety Redirect] Skipping original message "${content}" (${skipReason}). Sending safe phrase: "${safePhrase}"`);
        messageToSend = safePhrase;
    }

    let secondMessageToSend = null;
    let typoCorrection = null;

    const typoCooldown = 21600000; // 6 hours
    const canTypo = (Date.now() - lastGlobalTypoTime) > typoCooldown;

    if (canTypo && Math.random() < 0.01 && messageToSend.split(/\s+/).length > 1) {
        const words = messageToSend.split(/\s+/);
        const validIndices = words.map((w, i) => {
            const cleanWord = w.toLowerCase().replace(/[^a-z]/g, '');
            return (cleanWord.length >= 4 && !STOP_WORDS.has(cleanWord) && !TYPO_EXCLUDE_WORDS.has(cleanWord)) ? i : -1;
        }).filter(i => i !== -1);

        if (validIndices.length > 0) {
            const idxToTypo = validIndices[Math.floor(Math.random() * validIndices.length)];
            const originalWord = words[idxToTypo];
            const typoedWord = applyTypo(originalWord);
            if (originalWord !== typoedWord) {
                words[idxToTypo] = typoedWord;
                messageToSend = words.join(' ');
                typoCorrection = `${originalWord}*`;
                lastGlobalTypoTime = Date.now();
            }
        }
    }

    if (Math.random() < 0.05 && messageToSend.split(/\s+/).length >= 5) {
        const words = messageToSend.split(/\s+/);
        const splitIndex = Math.floor(words.length / 2) + (Math.random() > 0.5 ? 1 : 0);
        const firstPart = words.slice(0, splitIndex).join(' ');
        const secondPart = words.slice(splitIndex).join(' ');
        if (firstPart.length > 0 && secondPart.length > 0) {
            messageToSend = firstPart;
            secondMessageToSend = secondPart;
        }
    }

    const payload = { content: messageToSend, tts: false };
    if (targetReplyId) {
        payload.message_reference = { channel_id: channelId, message_id: targetReplyId, fail_if_not_exists: false };
    }

    let staggerDelay = minDelay + Math.random() * (maxDelay - minDelay);
    const typingDuration = Math.min(messageToSend.length * 150, 4000);
    staggerDelay = Math.max(0, staggerDelay - typingDuration);

    if (staggerDelay > 0) {
        await sleep(staggerDelay);
    }

    let lastChatTime = lastChannelChatTimes.get(channelId) || 0;
    let timeSinceLastChat = Date.now() - lastChatTime;
    if (!bypassStagger && (timeSinceLastChat < 45000)) {
        const extraDelay = (45000 - timeSinceLastChat) + Math.random() * 15000;
        console.log(`⏱️ [Staggering] Account chatted recently in ${channelId}. Staggering by ${Math.round(extraDelay / 1000)}s.`);
        await sleep(extraDelay);
    }

    await triggerTyping(token, channelId);
    await sleep(typingDuration);

    const accountObj = ACCOUNTS.find(a => a.token === token);
    const accountName = accountObj ? `@${accountObj.username}` : `token ...${token.slice(-6)}`;

    const sendMessageWithRetry = async (payloadObj, logMsg) => {
        for (let retryCount = 0; retryCount < 3; retryCount++) {
            const currentGame = activeTriviaGames.get(channelId);
            if (currentGame && !currentGame.isCancelled) {
                console.log(`🛡️ [Trivia is ON - Send Block] Blocking non-trivia message: "${payloadObj.content}"`);
                return null;
            }
            try {
                const res = await discord.post(`/channels/${channelId}/messages`, payloadObj, { headers: { Authorization: token } });
                console.log(`✅ [${accountName}] ${logMsg}: "${payloadObj.content}"`);
                sentMessagesMap.set(res.data.id, payloadObj.content.toLowerCase());
                pruneBoundedMap(sentMessagesMap, 2000);
                return res.data;
            } catch (e) {
                const errorData = e.response?.data;
                const retryAfterSec = errorData?.retry_after;
                if (e.response?.status === 429 || errorData?.code === 20016) {
                    const waitTimeMs = (retryAfterSec ? retryAfterSec * 1000 : 5000) + 100 + Math.random() * 200;
                    console.warn(`⏳ [Rate Limit] Waiting ${Math.round(waitTimeMs)}ms before retrying...`);
                    await sleep(waitTimeMs);
                } else {
                    console.error(`❌ Error sending message reply:`, errorData || e.message);
                    if (errorData) {
                        const code = errorData.code;
                        const msgText = errorData.message || '';
                        const isBlocked = code === 200000 || /moderation|blocked|automod|policy/i.test(msgText);
                        if (isBlocked) {
                            blockedPhrases.add(payloadObj.content.toLowerCase());
                            await saveBlockedPhrases();
                            console.warn(`🚨 [Moderation Blocked] "${payloadObj.content}" was blocked by AutoMod.`);
                        }
                    }
                    break;
                }
            }
        }
        return null;
    };

    const resData = await sendMessageWithRetry(payload, `Replied`);

    if (resData) {
        lastChannelChatTimes.set(channelId, Date.now());
        lastNormalChatTime.set(channelId, Date.now());

        if (accountObj) {
            accountObj.consecutiveReactions = 0;
            accountObj.reactionLimitBeforeMessage = 5 + Math.floor(Math.random() * 4);
        }

        registerPhraseCooldown(content);
        registerPhraseCooldown(messageToSend);

        if (secondMessageToSend) {
            await sleep(5500 + Math.random() * 1500);
            await triggerTyping(token, channelId);
            const typingDuration2 = Math.min(secondMessageToSend.length * 150, 4000);
            await sleep(typingDuration2);
            await sendMessageWithRetry({ content: secondMessageToSend, tts: false }, "Sent double text");
            registerPhraseCooldown(secondMessageToSend);
        }

        if (typoCorrection) {
            await sleep(12000 + Math.random() * 8000);
            await triggerTyping(token, channelId);
            await sleep(typoCorrection.length * 150);
            await sendMessageWithRetry({ content: typoCorrection, tts: false }, "Sent typo correction");
            registerPhraseCooldown(typoCorrection);
        }

        return resData;
    }
    return null;
}

async function sendTriviaGuess(token, channelId, content) {
    const payload = { content, tts: false };
    try {
        const res = await discord.post(`/channels/${channelId}/messages`, payload, { headers: { Authorization: token } });
        console.log(`🎯 [Trivia Guess] Sent guess: "${content}"`);
        giveawayStats.lastTrivia = `Sent **"${content}"**`;
        giveawayStats.lastTriviaTime = Math.floor(Date.now() / 1000);
        addActivityLog(`🎯 Guessed **"${content}"** in trivia`);


        const accountObj = ACCOUNTS.find(a => a.token === token);
        if (accountObj) {
            accountObj.consecutiveReactions = 0;
            accountObj.reactionLimitBeforeMessage = 5 + Math.floor(Math.random() * 4);
        }

        return res.data;
    } catch (e) {
        console.error(`❌ [Trivia Guess] Error sending guess "${content}":`, e.response?.data || e.message);
        return null;
    }
}

async function reactToMessage(token, channelId, messageId, emojiString, minDelay = MIN_REACTION_DELAY, maxDelay = MAX_REACTION_DELAY) {
    let formattedEmoji;
    if (emojiString.startsWith('<:') && emojiString.endsWith('>')) {
        formattedEmoji = emojiString.substring(2, emojiString.length - 1);
    } else if (emojiString.startsWith('<a:') && emojiString.endsWith('>')) {
        formattedEmoji = emojiString.substring(3, emojiString.length - 1);
    } else {
        formattedEmoji = emojiString;
    }
    const encodedEmoji = encodeURIComponent(formattedEmoji);

    const staggerDelay = minDelay + Math.random() * (maxDelay - minDelay);
    console.log(`⏳ Staggering reaction: waiting ${Math.round(staggerDelay)}ms (${(staggerDelay / 1000).toFixed(2)}s)...`);

    await ackMessage(token, channelId, messageId);
    await sleep(staggerDelay);

    const maxRetries = 5;
    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
        try {
            await discord.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`, null, { headers: { Authorization: token } });
            console.log(`✅ Reacted to message ${messageId} with ${emojiString}`);
            giveawayStats.totalReacted = (giveawayStats.totalReacted || 0) + 1;
            giveawayStats.lastReaction = emojiString;
            giveawayStats.lastReactionTime = Math.floor(Date.now() / 1000);
            addActivityLog(`✅ Reacted to message #${messageId.slice(-4)} with ${emojiString}`);

            const accountObj = ACCOUNTS.find(a => a.token === token);
            if (accountObj) {
                accountObj.consecutiveReactions = (accountObj.consecutiveReactions || 0) + 1;
                if (accountObj.consecutiveReactions >= accountObj.reactionLimitBeforeMessage) {
                    accountObj.consecutiveReactions = 0;
                    accountObj.reactionLimitBeforeMessage = 5 + Math.floor(Math.random() * 4);
                }
            }
            return true;
        } catch (e) {
            const errorData = e.response?.data;
            const retryAfterSec = errorData?.retry_after;
            if (e.response?.status === 429 && retryCount < maxRetries - 1) {
                const waitTimeMs = (retryAfterSec ? retryAfterSec * 1000 : 1000) + 100 + Math.random() * 200;
                console.warn(`⏳ [Rate Limit] Hit reaction 429. Waiting ${Math.round(waitTimeMs)}ms before retry...`);
                await sleep(waitTimeMs);
            } else {
                console.error(`❌ Error reacting to message ${messageId}:`, errorData || e.message);
                break;
            }
        }
    }
    return false;
}

// ==== TRIVIA ENGINE ==== //
function logTriviaAnswer(type, answer) {
    try {
        let history = {};
        if (fs.existsSync(TRIVIA_HISTORY_FILE)) {
            const data = fs.readFileSync(TRIVIA_HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
        }
        if (!history[type]) {
            history[type] = {};
        }
        history[type][answer] = (history[type][answer] || 0) + 1;
        fs.writeFileSync(TRIVIA_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
        console.log(`📈 [Trivia Stats - ${type}]:`, JSON.stringify(history[type]));
    } catch (err) {
        console.error("❌ Failed to log trivia answer:", err.message);
    }
}

function getSortedCandidates(type, candidates) {
    try {
        if (fs.existsSync(TRIVIA_HISTORY_FILE)) {
            const data = fs.readFileSync(TRIVIA_HISTORY_FILE, 'utf8');
            const history = JSON.parse(data);
            if (history[type]) {
                const stats = history[type];
                const shuffled = shuffleArray(candidates);
                return shuffled.sort((a, b) => {
                    const countA = stats[a] || 0;
                    const countB = stats[b] || 0;
                    return countB - countA;
                });
            }
        }
    } catch (err) {
        console.error("❌ Failed to sort candidates by history:", err.message);
    }
    return shuffleArray(candidates);
}

function applyMinorTypo(word) {
    if (!word || word.length <= 3) return word;
    // 50% chance to drop last letter (e.g. apple -> appl), 50% chance to swap adjacent letters
    if (Math.random() < 0.5) {
        return word.slice(0, -1);
    } else {
        const arr = word.split('');
        const idx = Math.floor(Math.random() * (arr.length - 1));
        const temp = arr[idx];
        arr[idx] = arr[idx + 1];
        arr[idx + 1] = temp;
        return arr.join('');
    }
}

async function runTriviaGuesses(account, channelId, candidates, gameInfo, gameType) {
    if (globalSecurityPauseUntil && Date.now() < globalSecurityPauseUntil) {
        console.log(`🛑 [Safety Lock] Trivia guess blocked due to active security pause.`);
        return;
    }
    await ackMessage(account.token, channelId, gameInfo.gameId);

    // Calculate realistic human reaction + typing delay
    const envMinTrivia = parseInt(process.env.MIN_TRIVIA_DELAY, 10);
    const envMaxTrivia = parseInt(process.env.MAX_TRIVIA_DELAY, 10);
    const minDelay = !isNaN(envMinTrivia) ? envMinTrivia : (triviaMode === 'y' ? 1500 : MIN_TRIVIA_DELAY);
    const maxDelay = !isNaN(envMaxTrivia) ? envMaxTrivia : (triviaMode === 'y' ? 2200 : MAX_TRIVIA_DELAY);
    const totalDelay = minDelay + Math.random() * (maxDelay - minDelay);

    // Anti-streak guard
    if (account.triviaSkipCount > 0) {
        account.triviaSkipCount--;
        console.log(`🛡️ [Trivia Streak Guard] @${account.username} is skipping/throwing this game. Remaining skips: ${account.triviaSkipCount}`);

        if (Math.random() < 0.30) {
            const sortedCandidates = getSortedCandidates(gameType, candidates);
            const bottomCount = Math.max(1, Math.floor(sortedCandidates.length * 0.3));
            const wrongCandidates = sortedCandidates.slice(-bottomCount);
            const wrongGuess = wrongCandidates[Math.floor(Math.random() * wrongCandidates.length)];

            if (wrongGuess) {
                const throwDelay = totalDelay * 0.8 + Math.random() * 800;
                await sleep(throwDelay * 0.65);
                const currentActive = activeTriviaGames.get(channelId);
                if (!currentActive || currentActive.gameId !== gameInfo.gameId || currentActive.isCancelled) return;
                await triggerTyping(account.token, channelId);
                await sleep(throwDelay * 0.35);
                if (!currentActive || currentActive.gameId !== gameInfo.gameId || currentActive.isCancelled) return;
                await sendTriviaGuess(account.token, channelId, wrongGuess);
                account.lastTriviaGuess = wrongGuess;
                account.lastTriviaGuessTime = Date.now();
                console.log(`🤪 [Trivia Intentionally Wrong] @${account.username} sent wrong guess: "${wrongGuess}"`);
            }
        }
        return;
    }

    console.log(`⏳ [Trivia Delay] Waiting ${Math.round(totalDelay)}ms before answering to avoid suspicion...`);

    // Phase 1: Reading/thinking time (65% of delay) - gives time for other people's guesses in chat to be tracked
    const readDelay = totalDelay * 0.65;
    await sleep(readDelay);

    let currentActive = activeTriviaGames.get(channelId);
    if (!currentActive || currentActive.gameId !== gameInfo.gameId || currentActive.isCancelled) {
        console.log(`🛑 [Trivia] Game ended or cancelled while waiting. Skipping guess.`);
        return;
    }

    // Phase 2: Typing indicator simulation (35% of delay) - shows Discord typing state
    const typingDelay = totalDelay * 0.35;
    await triggerTyping(account.token, channelId);
    await sleep(typingDelay);

    currentActive = activeTriviaGames.get(channelId);
    if (!currentActive || currentActive.gameId !== gameInfo.gameId || currentActive.isCancelled) {
        console.log(`🛑 [Trivia] Game ended or cancelled during typing. Skipping guess.`);
        return;
    }

    const sortedCandidates = getSortedCandidates(gameType, candidates);
    let index = 0;
    const maxDuration = 60000;
    const maxGuessesThisRound = 1;
    let guessCount = 0;

    while (Date.now() - gameInfo.startTime < maxDuration && !gameInfo.isCancelled) {
        currentActive = activeTriviaGames.get(channelId);
        if (!currentActive || currentActive.gameId !== gameInfo.gameId || currentActive.isCancelled) {
            break;
        }

        let guess = null;
        const startIdx = index;

        // 🎯 Find candidates that NO ONE in chat has guessed yet
        do {
            const candidate = sortedCandidates[index];
            const hasBeenTyped = gameInfo.typedAnswers && gameInfo.typedAnswers.has(candidate.toLowerCase());

            if (!hasBeenTyped) {
                // Untyped candidate - nobody in chat guessed this yet
                guess = candidate;
                break;
            }
            index = (index + 1) % sortedCandidates.length;
        } while (index !== startIdx);

        // If every candidate was already guessed by others, pick one with a minor typo
        if (!guess) {
            const fallback = sortedCandidates[Math.floor(Math.random() * sortedCandidates.length)];
            guess = applyMinorTypo(fallback);
        }

        if (guess) {
            // Avoid repeating the exact same guess as last time
            if (account.lastTriviaGuess && guess.toLowerCase() === account.lastTriviaGuess.toLowerCase() && sortedCandidates.length > 1) {
                const alt = sortedCandidates.find(c => c.toLowerCase() !== account.lastTriviaGuess.toLowerCase());
                if (alt) guess = alt;
            }

            index = (index + 1) % sortedCandidates.length;
            if (gameInfo.typedAnswers) {
                gameInfo.typedAnswers.add(guess.toLowerCase());
            }

            await sendTriviaGuess(account.token, channelId, guess);
            account.didGuessThisGame = true;
            account.lastTriviaGuess = guess;
            account.lastTriviaGuessTime = Date.now();
            guessCount++;
        }

        if (guessCount >= maxGuessesThisRound) {
            break;
        }
    }
    console.log(`🏁 [Trivia] Guessing loop ended for @${account.username || 'unknown'} in channel ${channelId}`);
}

async function handleTriviaGames(account, msg) {
    if (triviaMode === 'n') return;
    const channelId = msg.channel_id;
    const config = CONFIGS.find(c => c.channelId === channelId);
    if (!config) return;

    const authorId = msg.author?.id;
    const isFromTargetBot = authorId === config.targetBotId;

    let fullText = (msg.content || '');
    if (msg.embeds && msg.embeds.length) {
        for (const embed of msg.embeds) {
            fullText += '\n' + (embed.title || '') + '\n' + (embed.description || '');
            if (embed.fields && embed.fields.length) {
                for (const field of embed.fields) {
                    fullText += '\n' + (field.name || '') + '\n' + (field.value || '');
                }
            }
        }
    }
    const fullTextLower = fullText.toLowerCase();

    // Trivia starting soon detection
    const isTriviaSoon = isFromTargetBot && fullTextLower.includes('trivia') && (
        fullTextLower.includes('soon') ||
        fullTextLower.includes('starting in') ||
        fullTextLower.includes('starts in') ||
        fullTextLower.includes('seconds') ||
        fullTextLower.includes('minute') ||
        fullTextLower.includes('ready')
    ) && !fullTextLower.includes('correct');

    if (isTriviaSoon) {
        if (!globalTriviaSoonChats.has(msg.id)) {
            globalTriviaSoonChats.add(msg.id);
            globalLastTriviaSoonTime = Date.now();
            pruneBoundedSet(globalTriviaSoonChats, 100);
        }
    }

    // Trivia game end detection
    const isEndPhrase = fullTextLower.includes('guessed correctly') ||
        fullTextLower.includes('correctly guessed') ||
        (fullTextLower.includes('correct') && (fullTextLower.includes('was') || fullTextLower.includes('winner') || fullTextLower.includes('won') || fullTextLower.includes('no one')));

    if (isEndPhrase) {
        const activeGame = activeTriviaGames.get(channelId);
        if (activeGame) {
            activeGame.isCancelled = true;
            activeGame.endTime = Date.now();
            globalLastTriviaEndTime = Date.now();
            console.log(`🛑 [Trivia] Detected end phrase in channel ${channelId}. Stopping guesses.`);

            const type = activeGame.gameType;
            if (type) {
                let candidatesList = [];
                if (type === 'rank') candidatesList = TRIVIA_RANKS;
                else if (type === 'color') candidatesList = TRIVIA_COLORS;
                else if (type === 'animal') candidatesList = TRIVIA_ANIMALS;
                else if (type === 'food') candidatesList = TRIVIA_FOOD;
                else if (type === 'fruit') candidatesList = TRIVIA_FRUIT;
                else if (type === 'number') candidatesList = TRIVIA_NUMBERS;

                let detectedAnswer = null;
                for (const candidate of candidatesList) {
                    if (new RegExp(`\\b${candidate}\\b`, 'i').test(fullTextLower)) {
                        detectedAnswer = candidate;
                        break;
                    }
                }

                if (detectedAnswer) {
                    console.log(`📊 [Trivia Pattern Tracker] Detected correct answer was "${detectedAnswer}" for type "${type}".`);
                    logTriviaAnswer(type, detectedAnswer);
                }
            }

            // Streak tracking
            for (const acc of ACCOUNTS) {
                const usernameMatch = acc.username && fullTextLower.includes(acc.username.toLowerCase());
                const userIdMatch = acc.userId && (fullTextLower.includes(`<@${acc.userId}>`) || fullTextLower.includes(`<@!${acc.userId}>`));
                if (usernameMatch || userIdMatch) {
                    acc.triviaWinStreak = (acc.triviaWinStreak || 0) + 1;
                    console.log(`🏆 [Trivia Win Recorded] Account @${acc.username || acc.userId} won trivia! Streak: ${acc.triviaWinStreak}/${acc.triviaWinStreakThreshold}`);

                    if (acc.triviaWinStreak >= acc.triviaWinStreakThreshold) {
                        acc.triviaSkipCount = 5 + Math.floor(Math.random() * 4);
                        acc.triviaWinStreak = 0;
                        acc.triviaWinStreakThreshold = 2 + Math.floor(Math.random() * 2);
                        console.log(`🛡️ [Trivia Streak Guard] @${acc.username} will skip/throw next ${acc.triviaSkipCount} trivia games.`);
                    }
                    acc.didGuessThisGame = false;
                    break;
                }
            }

            for (const acc of ACCOUNTS) {
                if (acc.didGuessThisGame) {
                    const usernameMatch = acc.username && fullTextLower.includes(acc.username.toLowerCase());
                    const userIdMatch = acc.userId && (fullTextLower.includes(`<@${acc.userId}>`) || fullTextLower.includes(`<@!${acc.userId}>`));
                    if (!usernameMatch && !userIdMatch) {
                        acc.triviaWinStreak = 0;
                    }
                    acc.didGuessThisGame = false;
                }
            }
        }
        return;
    }

    // Track guesses typed in chat during game
    const activeGame = activeTriviaGames.get(channelId);
    if (activeGame && !activeGame.isCancelled) {
        let candidatesList = [];
        if (activeGame.gameType === 'rank') candidatesList = TRIVIA_RANKS;
        else if (activeGame.gameType === 'color') candidatesList = TRIVIA_COLORS;
        else if (activeGame.gameType === 'animal') candidatesList = TRIVIA_ANIMALS;
        else if (activeGame.gameType === 'food') candidatesList = TRIVIA_FOOD;
        else if (activeGame.gameType === 'fruit') candidatesList = TRIVIA_FRUIT;
        else if (activeGame.gameType === 'number') candidatesList = TRIVIA_NUMBERS;

        const contentLower = (msg.content || '').toLowerCase().trim();
        for (const candidate of candidatesList) {
            if (new RegExp(`\\b${candidate}\\b`, 'i').test(contentLower)) {
                if (activeGame.typedAnswers) {
                    activeGame.typedAnswers.add(candidate.toLowerCase());
                }
                if (activeGame.guesserIds && msg.author?.id) {
                    const isByUs = ACCOUNTS.some(acc => acc.userId && acc.userId === msg.author.id);
                    if (!isByUs) {
                        activeGame.guesserIds.add(msg.author.id);
                    }
                }
            }
        }
    }

    if (!isFromTargetBot) return;

    const cleanedText = fullTextLower.replace(/\*/g, '');
    let gameType = null;
    let candidates = [];

    if (cleanedText.includes('guess the correct rank')) {
        gameType = 'rank';
        candidates = TRIVIA_RANKS;
    } else if (cleanedText.includes('guess the correct color')) {
        gameType = 'color';
        candidates = TRIVIA_COLORS;
    } else if (cleanedText.includes('guess the correct animal')) {
        gameType = 'animal';
        candidates = TRIVIA_ANIMALS;
    } else if (cleanedText.includes('guess the correct food')) {
        gameType = 'food';
        candidates = TRIVIA_FOOD;
    } else if (cleanedText.includes('guess the correct fruit')) {
        gameType = 'fruit';
        candidates = TRIVIA_FRUIT;
    } else if (cleanedText.includes('guess the correct number') || cleanedText.includes('guess the number')) {
        gameType = 'number';
        candidates = TRIVIA_NUMBERS;
    }

    if (!gameType) return;

    // Global security lock (triggered by Luma or mod alert)
    if (globalSecurityPauseUntil && Date.now() < globalSecurityPauseUntil) {
        const remainingMinutes = Math.ceil((globalSecurityPauseUntil - Date.now()) / 60000);
        consoleLogUnique(`🛑 [Safety Lock Active] Trivia paused for ${remainingMinutes}m due to security warning.`);
        return;
    }

    // 45% natural human skip rate so account doesn't answer every game
    if (Math.random() < 0.45) {
        console.log(`🛡️ [Trivia Anti-Farm] @${account.username || 'unknown'} casually skipped this "${gameType}" game.`);
        return;
    }

    // Account resting cooldown check (minimum 120s = 2 minutes between games for this account)
    const timeSinceAccountGuess = Date.now() - (account.lastTriviaGuessTime || 0);
    if (timeSinceAccountGuess < 120000) {
        console.log(`🛡️ [Trivia Resting Cooldown] Account guessed ${Math.round(timeSinceAccountGuess / 1000)}s ago. Resting for at least 120s to avoid bot flag.`);
        return;
    }

    // Cooldown check (60s)
    const lastActiveGame = activeTriviaGames.get(channelId);
    if (lastActiveGame && lastActiveGame.endTime) {
        const timeSinceLastEnd = Date.now() - lastActiveGame.endTime;
        if (timeSinceLastEnd < 60000) {
            console.log(`🛡️ [Trivia Cooldown] Ignoring new game (${Math.round(timeSinceLastEnd / 1000)}s since last end, 60s required).`);
            return;
        }
    }

    if (lastActiveGame) {
        lastActiveGame.isCancelled = true;
    }

    const gameInfo = {
        gameId: msg.id,
        isCancelled: false,
        startTime: Date.now(),
        endTime: null,
        gameType: gameType,
        typedAnswers: new Set(),
        guesserIds: new Set()
    };
    activeTriviaGames.set(channelId, gameInfo);

    console.log(`\n🎮 [Trivia] Detected new "${gameType}" game in channel ${channelId}! Starting guessing loop...`);
    runTriviaGuesses(account, channelId, candidates, gameInfo, gameType).catch(err => {
        console.error(`❌ [Trivia] Error in runTriviaGuesses:`, err.message);
    });
}

// ==== GIVEAWAY ENGINE ==== //
async function handle100MConversation(account, channelId, msgId) {
    if (!global100MDecisionMap.has(`handled_${msgId}`)) {
        global100MDecisionMap.set(`handled_${msgId}`, true);
        pruneBoundedMap(global100MDecisionMap, 500);

        const phrase = getUniquePhrase(msgId, 'gl');
        const delay = 4000 + Math.random() * 8000;
        console.log(`💬 [Giveaway Reaction] @${account.username} will reply to giveaway in ${Math.round(delay / 1000)}s: "${phrase}"`);
        await sleep(delay);
        await sendReplyOrMessage(account.token, channelId, phrase, msgId, 0, 0, true, true);
    }
}

// ==== LIVE STATUS DASHBOARD & ACTIVITY MONITOR ==== //
const botStartTime = Date.now();
const GIVEAWAY_STATS_FILE = path.join(GWJOINBOT_DIR, 'giveaway_stats.json');
let giveawayStats = {
    totalWins: 0,
    hourlyWins: 0,
    totalReacted: 0,
    triviaGames: 0,
    triviaWins: 0,
    accountWins: {},
    liveMessageId: null,
    lastReaction: "None yet",
    lastReactionTime: null,
    lastTrivia: "None yet",
    lastTriviaTime: null,
    lastWin: "None yet",
    lastWinTime: null,
    activityLogs: []
};

function loadGiveawayStats() {
    try {
        if (fs.existsSync(GIVEAWAY_STATS_FILE)) {
            const data = fs.readFileSync(GIVEAWAY_STATS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            giveawayStats = { ...giveawayStats, ...parsed };
            if (!Array.isArray(giveawayStats.activityLogs)) giveawayStats.activityLogs = [];
            console.log(`🏆 Loaded stats: ${giveawayStats.totalWins} GW wins | ${giveawayStats.totalReacted} Reacted.`);
        }
    } catch (e) {
        console.error("❌ Failed to load giveaway_stats.json:", e.message);
    }
}

async function saveGiveawayStats() {
    try {
        await fs.promises.writeFile(GIVEAWAY_STATS_FILE, JSON.stringify(giveawayStats, null, 2), 'utf8');
    } catch (e) {
        console.error("❌ Failed to save giveaway_stats.json:", e.message);
    }
}

loadGiveawayStats();

function addActivityLog(text) {
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    giveawayStats.activityLogs.unshift(`\`[${timeStr}]\` ${text}`);
    if (giveawayStats.activityLogs.length > 5) {
        giveawayStats.activityLogs = giveawayStats.activityLogs.slice(0, 5);
    }
    saveGiveawayStats();
    updateLiveStatusWebhook().catch(() => { });
}

function recordGiveawayWin(account) {
    giveawayStats.totalWins = (giveawayStats.totalWins || 0) + 1;
    giveawayStats.hourlyWins = (giveawayStats.hourlyWins || 0) + 1;
    const accKey = account.username || account.userId || 'unknown';
    giveawayStats.accountWins[accKey] = (giveawayStats.accountWins[accKey] || 0) + 1;
    giveawayStats.lastWin = `@${accKey}`;
    giveawayStats.lastWinTime = Math.floor(Date.now() / 1000);
    addActivityLog(`🎉 **WON GIVEAWAY!** (@${accKey})`);
    console.log(`🏆 [GW Win] @${accKey} won! Total: ${giveawayStats.totalWins}`);
}

function formatUptime() {
    const totalSeconds = Math.floor((Date.now() - botStartTime) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

async function updateLiveStatusWebhook() {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL || "https://canary.discord.com/api/webhooks/1554062207896002682/wWFgeZXx5JeCJd85eAhgm3vg73mQt1EM_bOEWTOAMNmhp_mpimAe_0TrDa_TCA94XO8Y";
    if (!webhookUrl || !webhookUrl.startsWith("http")) return;

    const onlineAccounts = ACCOUNTS.map(acc => {
        const stateEmoji = acc.connectionState === 'connected' ? '🟢' : '🔴';
        return `${stateEmoji} **@${acc.username || 'Connecting...'}** (\`${acc.userId || 'N/A'}\`) • In VC 🔊`;
    }).join('\n') || 'No accounts loaded';

    const recentLogs = giveawayStats.activityLogs.length > 0
        ? giveawayStats.activityLogs.join('\n')
        : '• *Waiting for events (reactions, trivia, wins)...*';

    const lastReactStr = giveawayStats.lastReactionTime
        ? `${giveawayStats.lastReaction} (<t:${giveawayStats.lastReactionTime}:R>)`
        : 'None yet';

    const lastTriviaStr = giveawayStats.lastTriviaTime
        ? `${giveawayStats.lastTrivia} (<t:${giveawayStats.lastTriviaTime}:R>)`
        : 'None yet';

    const lastWinStr = giveawayStats.lastWinTime
        ? `${giveawayStats.lastWin} (<t:${giveawayStats.lastWinTime}:R>)`
        : 'None yet';

    const payload = {
        username: "GWJoinBot Live Dashboard",
        embeds: [
            {
                title: "⚡ GWJoinBot Live Status & Activity Monitor",
                color: 0x5865F2,
                fields: [
                    {
                        name: "👥 Connected Accounts",
                        value: onlineAccounts,
                        inline: false
                    },
                    {
                        name: "🎁 Giveaway Stats",
                        value: `• **Total Wins**: ${giveawayStats.totalWins || 0}\n• **Wins (This Hour)**: ${giveawayStats.hourlyWins || 0}\n• **Total Reacted**: ${giveawayStats.totalReacted || 0}`,
                        inline: true
                    },
                    {
                        name: "🎮 Trivia Stats",
                        value: `• **Total Games**: ${giveawayStats.triviaGames || 0}\n• **Trivia Wins**: ${giveawayStats.triviaWins || 0}`,
                        inline: true
                    },
                    {
                        name: "⚡ Latest Action Overview",
                        value: `• **Last Reaction**: ${lastReactStr}\n• **Last Trivia**: ${lastTriviaStr}\n• **Last Win**: ${lastWinStr}`,
                        inline: false
                    },
                    {
                        name: "📜 Live Activity Log (Recent 5 Actions)",
                        value: recentLogs,
                        inline: false
                    },
                    {
                        name: "⏱️ System Status",
                        value: `• **Uptime**: \`${formatUptime()}\`\n• **Last Refreshed**: <t:${Math.floor(Date.now() / 1000)}:R>`,
                        inline: false
                    }
                ],
                footer: { text: "Live Dashboard • Auto-refreshes every 45s" },
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        if (giveawayStats.liveMessageId) {
            await axios.patch(`${webhookUrl}/messages/${giveawayStats.liveMessageId}`, payload, {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            const res = await axios.post(`${webhookUrl}?wait=true`, payload, {
                headers: { 'Content-Type': 'application/json' }
            });
            if (res.data?.id) {
                giveawayStats.liveMessageId = res.data.id;
                await saveGiveawayStats();
            }
        }
    } catch (e) {
        if (e.response?.status === 404) {
            giveawayStats.liveMessageId = null;
            await saveGiveawayStats();
        }
    }
}

// Auto-refresh every 45 seconds
setInterval(updateLiveStatusWebhook, 45 * 1000);

// Reset hourly counter every 60m
setInterval(() => {
    giveawayStats.hourlyWins = 0;
    saveGiveawayStats();
    updateLiveStatusWebhook().catch(() => { });
}, 60 * 60 * 1000);


async function sendWinWebhookNotification(account, msg, fullText) {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL || "https://canary.discord.com/api/webhooks/1554062207896002682/wWFgeZXx5JeCJd85eAhgm3vg73mQt1EM_bOEWTOAMNmhp_mpimAe_0TrDa_TCA94XO8Y";
    if (!webhookUrl || !webhookUrl.startsWith("http")) return;
    const payload = {
        username: "Giveaway Win Tracker",
        content: `🎉 **GIVEAWAY WIN DETECTED!** 🎉\n**Account**: @${account.username} (${account.userId})\n**Channel**: <#${msg.channel_id}>\n**Message Details**:\n${fullText}`
    };
    try {
        await axios.post(webhookUrl, payload, { headers: { 'Content-Type': 'application/json' } });
        console.log(`🔔 Sent win webhook notification for @${account.username}!`);
    } catch (e) {
        console.error(`❌ Failed to send win webhook notification:`, e.message);
    }
}

async function handleGiveawayMessage(account, msg) {
    const channelId = msg.channel_id;
    const config = CONFIGS.find(c => c.channelId === channelId);
    if (!config) return;

    const isFromBot = (msg.author && msg.author.id === config.targetBotId) || (!msg.author);
    if (!isFromBot || !msg.embeds || !msg.embeds.length) return;

    let embedText = '';
    for (const embed of msg.embeds) {
        embedText += '\n' + (embed.title || '') + '\n' + (embed.description || '');
        if (embed.fields && embed.fields.length) {
            for (const field of embed.fields) {
                embedText += '\n' + (field.name || '') + '\n' + (field.value || '');
            }
        }
        if (embed.footer && embed.footer.text) {
            embedText += '\n' + embed.footer.text;
        }
    }
    embedText = embedText.toLowerCase();

    // Trap & Honeypot detection
    if (isTrapMessage(embedText) || isTrapMessage(msg.content || '')) {
        console.warn(`🚨 [TRAP DETECTED] Ignoring suspicious giveaway message ${msg.id}`);
        return;
    }

    const containsPhrase = config.targetPhrases.some(p => embedText.includes(p.toLowerCase()));
    if (!containsPhrase) return;

    const isStartingGiveaway = embedText.includes('enter by reacting') || embedText.includes('react with') || embedText.includes('reacting') || embedText.includes('react to');

    if (isStartingGiveaway) {
        if (!account.reactedMessages.has(msg.id)) {
            account.reactedMessages.add(msg.id);
            pruneBoundedSet(account.reactedMessages, 500);

            console.log(`🔎 [Giveaway] @${account.username} is reacting to giveaway ${msg.id}`);

            (async () => {
                let reactionEmoji = config.customEmoji;
                let currentMsg = msg;

                if (!currentMsg.reactions || currentMsg.reactions.length === 0) {
                    console.log(`⏳ Waiting 1.5s to fetch giveaway reactions...`);
                    await sleep(1500);
                    try {
                        const res = await discord.get(`/channels/${config.channelId}/messages?around=${msg.id}&limit=1`, {
                            headers: { Authorization: account.token }
                        });
                        if (res.data && res.data.length > 0) {
                            currentMsg = res.data[0];
                        }
                    } catch (err) {
                        console.error(`⚠️ Failed to fetch updated giveaway message:`, err.message);
                    }
                }

                if (currentMsg.reactions && currentMsg.reactions.length > 0) {
                    const firstReact = currentMsg.reactions[0];
                    if (firstReact?.emoji) {
                        const emoji = firstReact.emoji;
                        reactionEmoji = emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : emoji.name;
                        console.log(`🔎 [Giveaway] Detected existing reaction emoji: ${reactionEmoji}. Using it.`);
                    }
                }

                await reactToMessage(account.token, config.channelId, msg.id, reactionEmoji, account.minReactDelay, account.maxReactDelay);
            })().catch(err => console.error(`❌ Error reacting:`, err.message));
        }
    } else {
        // Winning message detection
        if (!account.processedWinningMessages.has(msg.id)) {
            account.processedWinningMessages.add(msg.id);
            pruneBoundedSet(account.processedWinningMessages, 500);
            console.log(`🎉 Giveaway winning message detected ${msg.id} for @${account.username || 'unknown'}`);

            let wonAccount = null;
            for (const acc of ACCOUNTS) {
                const usernameMatch = acc.username && embedText.includes(acc.username.toLowerCase());
                const userIdMatch = acc.userId && (embedText.includes(`<@${acc.userId}>`) || embedText.includes(`<@!${acc.userId}>`));
                if (usernameMatch || userIdMatch) {
                    wonAccount = acc;
                    break;
                }
            }
            if (wonAccount) {
                recordGiveawayWin(wonAccount); // 👈 Add this line here
                sendWinWebhookNotification(wonAccount, msg, embedText).catch(err => {
                    console.error("❌ Failed to dispatch win notification:", err.message);
                });
            }

        }
    }
}

// ==== INBOUND MENTIONS & CHAT REPLIES ==== //
async function handleIncomingRepliesAndMentions(account, msg) {
    if (!account.userId || !msg.author) return;
    if (msg.author.bot) return;
    if (ACCOUNTS.some(acc => acc.userId && acc.userId === msg.author.id)) return;

    const isTargeted = (msg.mentions && msg.mentions.some(user => user.id === account.userId)) ||
        (msg.content && (msg.content.includes(`<@${account.userId}>`) || msg.content.includes(`<@!${account.userId}>`))) ||
        (msg.referenced_message && msg.referenced_message.author && msg.referenced_message.author.id === account.userId);

    if (!isTargeted) return;

    const cooldownKey = `${account.userId}-${msg.author.id}`;
    const lastReplyTime = userLastReplyTimes.get(cooldownKey) || 0;
    const now = Date.now();
    if (now - lastReplyTime < 45000) return;

    const text = (msg.content || '').toLowerCase();
    const authorName = (msg.author.username || '').toLowerCase();
    const isStaffOrMod = /mod|admin|staff|owner|helper|lead|founder|support/i.test(authorName);
    const isBottingAccusation =
        text.includes('botting') ||
        text.includes('chat farm') ||
        text.includes('chatfarm') ||
        text.includes('chat farmer') ||
        text.includes('chat farming') ||
        text.includes('farming chat') ||
        text.includes('are u here') ||
        text.includes('are you here') ||
        text.includes('u here') ||
        text.includes('you here') ||
        text.includes('macroing') ||
        text.includes('macro') ||
        text.includes('are u a bot') ||
        text.includes('are you a bot') ||
        text.includes('u a bot') ||
        text.includes('you a bot') ||
        text.includes('bot?') ||
        text.includes('farm') ||
        text.includes('what is') ||
        text.includes('say banana') ||
        text.includes('type ') ||
        text.includes('solve ') ||
        (text.includes('bot') && (text.includes('are u') || text.includes('are you') || text.includes('ur') || text.includes('youre') || text.includes('you\'re') || text.includes('u ') || text.includes('you ')));

    if (isBottingAccusation || isStaffOrMod) {
        userLastReplyTimes.set(cooldownKey, now);
        pruneBoundedMap(userLastReplyTimes, 500);
        console.warn(`🚨 [URGENT MOD/BOT CHECK] Mentioned by @${msg.author.username}: "${msg.content}"`);

        // Mute channel automated chat for 20 mins
        lastNormalChatTime.set(msg.channel_id, Date.now() + 1200000);

        handleBotCheckSay(account, msg, text);
        sendUrgentModAlert(account, msg, isStaffOrMod ? "Staff/Mod Direct Mention" : "Botting Accusation / Check");
        return;
    }

    if (minigameOnly) return;

    // Snipe comments
    if (text.includes('snipe') || text.includes('sniped') || text.includes('sneep')) {
        userLastReplyTimes.set(cooldownKey, now);
        pruneBoundedMap(userLastReplyTimes, 500);
        console.log(`🎯 [Snipe Reply] @${msg.author.username} commented on snipe to @${account.username}`);
        const phrase = getUniqueFromList(SNIPE_REPLIES);
        await sendReplyOrMessage(account.token, msg.channel_id, phrase, msg.id, account.minReplyDelay, account.maxReplyDelay, true, false);
        return;
    }

    // Praise comments
    const isNiceGuessComment =
        text.includes('nice guess') || text.includes('good guess') || text.includes('w guess') ||
        text.includes('clean guess') || text.includes('great guess') || text.includes('insane guess') ||
        text.includes('crazy guess') || text.includes('nice one') || text.includes('good one') ||
        text.includes('nice win') || text.includes('good win') || text.includes('congrats') ||
        text.includes('grats') || text.includes('ggs') || text === 'gg' || text === 'wp';

    if (isNiceGuessComment) {
        userLastReplyTimes.set(cooldownKey, now);
        pruneBoundedMap(userLastReplyTimes, 500);
        console.log(`🙏 [Nice Guess Reply] @${msg.author.username} praised @${account.username}`);
        const phrase = getUniqueFromList(NICE_GUESS_REPLIES);
        await sendReplyOrMessage(account.token, msg.channel_id, phrase, msg.id, account.minReplyDelay, account.maxReplyDelay, true, false);
        return;
    }

    // Quick inquiries
    const isQuickInquiry =
        text.includes('you there') || text.includes('u there') || text.includes('are you there') ||
        text.includes('are u there') || text.includes('active?') || text.includes('active') ||
        text.includes('are you active') || text.includes('are u active') || text.includes('afk?') ||
        text.includes('are u afk') || text.includes('are you afk') || text.includes('yo') ||
        text.includes('hello') || text.includes('hi');

    if (isQuickInquiry) {
        userLastReplyTimes.set(cooldownKey, now);
        pruneBoundedMap(userLastReplyTimes, 500);
        console.log(`💬 [Quick Inquiry Reply] @${msg.author.username} queried @${account.username}`);
        const quickReplies = ["ye", "yeah", "yep", "mhm", "chilling", "yo", "hey", "what's up", "im here", "watching chat", "still here"];
        const phrase = quickReplies[Math.floor(Math.random() * quickReplies.length)];
        await sendReplyOrMessage(account.token, msg.channel_id, phrase, msg.id, account.minReplyDelay, account.maxReplyDelay, true, false);
        return;
    }

    console.log(`🎲 Ignored normal reply/ping from @${msg.author.username} to @${account.username}`);
}

function handleMainUserAlerts(account, msg) {
    if (!msg.author) return;
    if (ACCOUNTS.some(acc => acc.userId === msg.author.id)) return;
    if (!myUserId) return;

    let mentionsMainUser = (msg.mentions && msg.mentions.some(u => u.id === myUserId)) ||
        (msg.referenced_message?.author?.id === myUserId);
    const text = (msg.content || '').toLowerCase();
    if (text.includes(`<@${myUserId}>`) || text.includes(`<@!${myUserId}>`)) mentionsMainUser = true;

    if (mentionsMainUser) {
        if (text.includes('bot') || text.includes('macro')) {
            if (!globalAlertedMessages.has(msg.id)) {
                globalAlertedMessages.add(msg.id);
                pruneBoundedSet(globalAlertedMessages, 100);
                console.warn(`🚨 ALERT KEYWORD DETECTED from @${msg.author.username}: "${msg.content}"`);
            }
        }
    }
}

async function handleDirectMessagesAndWarnings(account, msg) {
    if (!msg || !account) return;

    const isDM = !msg.guild_id;
    const authorUsername = (msg.author?.username || '').toLowerCase();
    const authorId = msg.author?.id || '';

    let fullContent = (msg.content || '');
    if (msg.embeds && msg.embeds.length) {
        for (const embed of msg.embeds) {
            fullContent += '\n' + (embed.title || '') + '\n' + (embed.description || '');
            if (embed.fields) {
                for (const f of embed.fields) {
                    fullContent += '\n' + (f.name || '') + '\n' + (f.value || '');
                }
            }
        }
    }
    const lowerContent = fullContent.toLowerCase();

    const isLumaOrSecurityBot = authorUsername.includes('luma') || authorId === '1344240724526235759';

    const mentionsThisAccount =
        (account.userId && msg.mentions && msg.mentions.some(u => u.id === account.userId)) ||
        (account.userId && (fullContent.includes(`<@${account.userId}>`) || fullContent.includes(`<@!${account.userId}>`))) ||
        (account.userId && msg.referenced_message?.author?.id === account.userId) ||
        (account.username && lowerContent.includes(account.username.toLowerCase()));

    const isWarningTrigger =
        lowerContent.includes('farming or botting') ||
        lowerContent.includes('chat farmer') ||
        lowerContent.includes('potential chat farmer') ||
        lowerContent.includes('punishment') ||
        lowerContent.includes('flagged you') ||
        lowerContent.includes('flagged for') ||
        lowerContent.includes('suspected of botting') ||
        lowerContent.includes('anti-cheat') ||
        lowerContent.includes('captcha') ||
        lowerContent.includes('solve this') ||
        lowerContent.includes('verification');

    // In DMs: Flag if Luma/Security bot DMs us, or if message contains warning keywords
    const isDMWarning = isDM && (
        isLumaOrSecurityBot ||
        isWarningTrigger ||
        lowerContent.includes('bot') ||
        lowerContent.includes('warn')
    );

    // In Guild: ONLY flag if it specifically targets this account AND contains warning keywords
    const isGuildWarning = !isDM && mentionsThisAccount && isWarningTrigger;

    if (isDMWarning || isGuildWarning) {
        console.warn(`🚨🚨 [SECURITY WARNING DETECTED] Account: @${account.username}`);
        console.warn(`Content: ${fullContent}`);

        // Automatically pause all automated trivia and chatting for 15 minutes
        globalSecurityPauseUntil = Date.now() + (15 * 60 * 1000);

        await sendUrgentModAlert(
            account,
            msg,
            `⚠️ SECURITY WARNING DETECTED! Automated trivia & chatting paused for 15 minutes to protect account.`
        );
    }
}

function applyTypo(word) {
    if (word.length <= 3) return word;
    if (Math.random() < 0.5) {
        const lastChar = word.slice(-1);
        return /[a-zA-Z]/.test(lastChar) ? word + lastChar : word;
    } else {
        const idx = Math.floor(1 + Math.random() * (word.length - 3));
        const chars = word.split('');
        const temp = chars[idx];
        chars[idx] = chars[idx + 1];
        chars[idx + 1] = temp;
        return chars.join('');
    }
}

function getActivityPayload() {
    return [];
}

async function fetchAccountDetails(account) {
    try {
        const res = await discord.get('/users/@me', { headers: { Authorization: account.token } });
        account.username = res.data.username;
        account.userId = res.data.id;
        console.log(`🟩 Authenticated as: @${account.username} (${account.userId})`);
        return true;
    } catch (e) {
        console.error(`❌ Failed to authenticate token ending in ...${account.token.slice(-6)}:`, e.response?.data || e.message);
        return false;
    }
}

function joinVoiceChannels(ws, username) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const vc of VOICE_CHANNELS) {
        console.log(`🔊 [Voice - @${username || 'unknown'}] Joining VC ${vc.channelId} in guild ${vc.guildId}...`);
        ws.send(JSON.stringify({
            op: 4,
            d: {
                guild_id: vc.guildId,
                channel_id: vc.channelId,
                self_mute: true,
                self_deaf: true,
                self_video: false
            }
        }));
    }
}

// ==== GATEWAY CONNECTION LIFECYCLE MANAGER ==== //
function cleanupAccountTimers(account) {
    if (account.heartbeatTimer) {
        clearInterval(account.heartbeatTimer);
        account.heartbeatTimer = null;
    }
    if (account.presenceTimer) {
        clearInterval(account.presenceTimer);
        account.presenceTimer = null;
    }
    if (account.reconnectTimer) {
        clearTimeout(account.reconnectTimer);
        account.reconnectTimer = null;
    }
}

function connectGateway(index, retryCount = 0) {
    const account = ACCOUNTS[index];
    if (!account) return;

    // Prevent duplicate concurrent connection attempts
    if (account.connectionState === 'connecting' || account.connectionState === 'connected') {
        console.log(`ℹ️ [Gateway - @${account.username || index}] Already ${account.connectionState}. Skipping redundant connect.`);
        return;
    }

    cleanupAccountTimers(account);
    account.connectionState = 'connecting';

    console.log(`🔌 [Gateway - @${account.username || index}] Connecting...`);

    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json', {
        headers: {
            'User-Agent': SUPER_PROPERTIES.browser_user_agent,
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
        }
    });

    account.ws = ws;
    account.lastHeartbeatAck = true;

    const sendHeartbeat = () => {
        if (!account.lastHeartbeatAck) {
            console.warn(`⚠️ [Gateway - @${account.username}] Missed heartbeat ACK. Reconnecting...`);
            ws.close(4000, 'Heartbeat timeout');
            return;
        }
        account.lastHeartbeatAck = false;
        ws.send(JSON.stringify({ op: 1, d: null }));
    };

    ws.on('open', () => {
        console.log(`📡 [Gateway - @${account.username || index}] Socket opened`);
    });

    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data.toString());
            const { op, t, d } = payload;

            if (op === 10) {
                // Hello opcode
                const heartbeatInterval = d.heartbeat_interval;
                account.lastHeartbeatAck = true;
                account.heartbeatTimer = setInterval(sendHeartbeat, heartbeatInterval);

                const initialStatus = Math.random() > 0.5 ? 'online' : 'idle';
                const identifyPayload = {
                    op: 2,
                    d: {
                        token: account.token,
                        capabilities: 16381,
                        properties: SUPER_PROPERTIES,
                        presence: {
                            status: initialStatus,
                            since: 0,
                            activities: getActivityPayload(),
                            afk: initialStatus === 'idle'
                        },
                        compress: false,
                        client_state: {
                            guild_versions: {},
                            highest_last_message_id: '0',
                            read_state_version: 0,
                            user_guild_settings_version: 0,
                            user_settings_version: 0,
                            private_channels_version: 0,
                            api_code_version: 0
                        }
                    }
                };
                ws.send(JSON.stringify(identifyPayload));
            } else if (op === 11) {
                // Heartbeat ACK
                account.lastHeartbeatAck = true;
            } else if (op === 0) {
                // Dispatch
                if (t === 'READY') {
                    account.connectionState = 'connected';
                    account.userId = d.user.id;
                    account.username = d.user.username;
                    console.log(`🟩 [Gateway - @${account.username}] Successfully logged in as @${account.username} (${account.userId})`);

                    joinVoiceChannels(ws, account.username);

                    if (account.presenceTimer) clearInterval(account.presenceTimer);
                    account.presenceTimer = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            const newStatus = Math.random() > 0.4 ? 'online' : 'idle';
                            const newActivities = getActivityPayload();
                            ws.send(JSON.stringify({
                                op: 3,
                                d: { status: newStatus, since: 0, activities: newActivities, afk: newStatus === 'idle' }
                            }));
                            const actName = newActivities.length ? newActivities[0].name : 'None';
                            console.log(`🔄 [Gateway - @${account.username}] Updated presence: ${newStatus} | Activity: ${actName}`);
                        }
                    }, 1000 * 60 * 30 + Math.random() * 1000 * 60 * 30);
                } else if (t === 'MESSAGE_CREATE') {
                    updateChannelHistory(d);
                    if (d.author?.id === myUserId) {
                        lastMainUserMessageIds.set(d.channel_id, d.id);
                    }
                    handleDirectMessagesAndWarnings(account, d);
                    handleGiveawayMessage(account, d);
                    handleIncomingRepliesAndMentions(account, d);
                    handleMainUserAlerts(account, d);
                    handleTriviaGames(account, d);
                } else if (t === 'MESSAGE_UPDATE') {
                    handleGiveawayMessage(account, d);
                    handleTriviaGames(account, d);
                } else if (t === 'MESSAGE_DELETE') {
                    if (sentMessagesMap.has(d.id)) {
                        const deletedText = sentMessagesMap.get(d.id);
                        if (!blockedPhrases.has(deletedText)) {
                            blockedPhrases.add(deletedText);
                            saveBlockedPhrases();
                            console.warn(`🚨 [AutoMod Detected] Our message was deleted: "${deletedText}". Added to blocklist.`);
                        }
                        sentMessagesMap.delete(d.id);
                    }
                } else if (t === 'MESSAGE_DELETE_BULK') {
                    if (d.ids && Array.isArray(d.ids)) {
                        for (const msgId of d.ids) {
                            if (sentMessagesMap.has(msgId)) {
                                const deletedText = sentMessagesMap.get(msgId);
                                if (!blockedPhrases.has(deletedText)) {
                                    blockedPhrases.add(deletedText);
                                    saveBlockedPhrases();
                                    console.warn(`🚨 [AutoMod Detected] Bulk deleted: "${deletedText}". Added to blocklist.`);
                                }
                                sentMessagesMap.delete(msgId);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`❌ [Gateway - @${account.username}] Error parsing message:`, e.message);
        }
    });

    ws.on('close', async (code, reason) => {
        console.warn(`🔌 [Gateway - @${account.username}] Connection closed. Code: ${code}, Reason: ${reason}`);
        cleanupAccountTimers(account);
        account.connectionState = 'disconnected';

        if (code === 4004) {
            console.error(`❌ Authentication Failed for @${account.username} (Code 4004). Halting reconnect.`);
            return;
        }
        if (account.intentionalClose) {
            console.log(`💤 [Gateway - @${account.username}] Disconnected intentionally.`);
            return;
        }

        account.connectionState = 'reconnecting';
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        console.log(`🔄 [Gateway - @${account.username}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${retryCount + 1})...`);

        account.reconnectTimer = setTimeout(() => {
            account.reconnectTimer = null;
            connectGateway(index, retryCount + 1);
        }, delay);
    });

    ws.on('error', (err) => {
        console.error(`❌ [Gateway - @${account.username}] Socket Error:`, err.message);
    });
}

// Global watchdog to reconnect dropped accounts safely
setInterval(() => {
    ACCOUNTS.forEach((account, index) => {
        if (!account.userId) return;
        if (account.intentionalClose) return;

        // Only reconnect if truly disconnected and no reconnect timer is pending
        if (account.connectionState === 'disconnected' && !account.reconnectTimer) {
            console.log(`🌅 [Scheduler - @${account.username}] Watchdog triggered reconnection.`);
            connectGateway(index);
        }
    });
}, 60000);

// ==== MAIN ENTRY POINT ==== //
async function main() {
    console.log("🚀 Starting Multi-User Giveaway & Trivia Bot...");
    await askUserPreferences();

    let authenticatedCount = 0;
    for (const account of ACCOUNTS) {
        const authenticated = await fetchAccountDetails(account);
        if (authenticated) authenticatedCount++;
    }

    if (authenticatedCount === 0) {
        console.error("❌ No accounts could be authenticated.");
        console.error("👉 Please verify DISCORD_TOKENS in your Render environment variables or .env file!");
        process.exit(1);
    }

    for (let i = 0; i < ACCOUNTS.length; i++) {
        if (ACCOUNTS[i].userId) {
            if (i > 0) {
                const startDelay = 5000 + Math.random() * 15000;
                console.log(`⏱️ Staggering next account login by ${Math.round(startDelay / 1000)}s...`);
                await sleep(startDelay);
            }
            connectGateway(i);
        }
    }
}

main();
