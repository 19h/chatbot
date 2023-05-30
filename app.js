const fs = require('fs');

const Keyv = require('keyv');
const { KeyvFile } = require('keyv-file');

const gpt3tokenizer = require('gpt-3-encoder');

const sharp = require('sharp');

async function copilotStreamed(url, opts) {
    const response = await fetch(url, opts);

    if (!response.ok) {
        return null;
    }

    const reader = response.body.getReader();
    let decoder = new TextDecoder();

    const processResult = result => {
        return decoder.decode(result.value, { stream: true });
    };

    return new Promise(async (resolve, reject) => {
        const chunks = [];

        while (true) {
            const result = await reader.read();

            if (result.done) {
                break;
            }

            chunks.push(processResult(result));
        }

        const resp = {
            role: 'assistant',
            content: '',
        };

        try {
            const lines = chunks.join('').split('\n\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.choices[0]['finish_reason'] !== null) {
                            break;
                        }

                        if ('role' in data.choices[0].delta) {
                            resp.role = data.choices[0].delta.role;
                            resp.content = '';
                        }

                        if ('content' in data.choices[0].delta) {
                            resp.content += data.choices[0].delta.content;
                        }
                    } catch {
                        continue;
                    }
                }
            }

            resolve(resp);
        } catch (e) {
            reject(e);
        }
    });
}

const keyv = new Keyv({
    store: new KeyvFile({
        filename: './keyv/db.json',
        expiredCheckDelay: 24 * 3600 * 1000,
        writeDelay: 10,
        encode: data => JSON.stringify(data, null, 4),
        decode: JSON.parse,
    }),
});

(async () => {
    const TelegramBot = require('node-telegram-bot-api');
    const { Graphviz } = await import('@hpcc-js/wasm/graphviz');

    const graphviz = await Graphviz.load();

    const token = process.env.TELEGRAM_TOKEN;

    const bot = new TelegramBot(token, { polling: true });

    const sendTempMessage = (chatId, text, ms, options = {}) =>
        bot.sendMessage(chatId, text, options)
            .then(message => {
                setTimeout(
                    () => bot.deleteMessage(chatId, message.message_id),
                    ms,
                );
            });

    const profiles = new Map();

    const reload_profiles = () => {
        try {
            const data = fs.readFileSync('profiles.json', 'utf8');

            // delete all profiles
            profiles.clear();

            // add new profiles
            for (const [key, value] of JSON.parse(data)) {
                profiles.set(key, value);
            }
        } catch (err) {
            console.error(err);
        }
    };

    reload_profiles();

    class ChatGPTAPI {
        constructor() {
            this.pat_token = process.env.GITHUB_PAT_TOKEN;
            this.cat_token = null;
            this.cat_token_lud = null;
        }

        async update_cat_if_needed() {
            for (let i = 0; i < 5; i++) {
                if (
                    this.cat_token_lud !== null
                    && (Date.now() - this.cat_token_lud) < 120_000
                ) {
                    return;
                }

                try {
                    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
                        "method": "GET",
                        "headers": {
                            "Authorization": "token " + this.pat_token,
                            "User-Agent": "GithubCopilot/1.86.92"
                        }
                    });

                    const json = await res.json();

                    this.cat_token = json.token;
                    this.cat_token_lud = Date.now();

                    return;
                } catch (err) {
                    console.error(err);

                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            throw new Error('Failed to update cat token after 5 retries');
        }

        async completion(
            messages,
            temperature = 0.1,
            top_p = 1,
            n = 1,
        ) {
            await this.update_cat_if_needed();

            const signal = new AbortController();

            let out_reject, out_resolve;

            const output = new Promise((resolve, reject) => {
                out_reject = reject;
                out_resolve = resolve;
            });

            const timeout = setTimeout(() => {
                signal.abort();

                reject(new Error('Timeout'));
            }, 40000);

            try {
                const copstr = copilotStreamed(
                    "https://copilot-proxy.githubusercontent.com/v1/chat/completions",
                    {
                        "method": "POST",
                        "headers": {
                            "Authorization": `Bearer ${this.cat_token}`,
                            "Content-Type": "application/json"
                        },
                        "body": JSON.stringify({
                            "stream": true,
                            "intent": false,
                            "messages": messages.map(message => ({
                                ...message,
                                content: message.content.trim(),
                            })),
                            "model": "copilot-chat",
                            "temperature": temperature,
                            "top_p": top_p,
                            "n": n
                        }),
                        signal: signal.signal,
                    },
                );

                copstr.then(data => {
                    clearTimeout(timeout);

                    if (data === null) {
                        out_reject(
                            new Error('Failed to get response from copilot'),
                        );

                        return;
                    }

                    out_resolve(data.content);
                });
            } catch (err) {
                clearTimeout(timeout);

                out_reject(err);
            }

            return output;
        }
    }

    class ClaudeAPI {
        constructor() {
            this.apiKey = process.CLAUDE_API_TOKEN;
        }
    
        formatMessages(messages) {
            let formattedMessages = '';
    
            for (const message of messages) {
                if (message.role === 'system' || message.role === 'user') {
                    formattedMessages += `\n\nHuman: ${message.content}`;
                } else if (message.role === 'assistant') {
                    formattedMessages += `\n\nAssistant: ${message.content}`;
                }
            }
    
            return formattedMessages;
        }

        async completion(
            messages,
            temperature = 0.1,
            max_tokens = 10000,
        ) {
            return this.completion_raw(
                this.formatMessages([
                    ...messages,
                    {
                        role: 'assistant',
                        content: '',
                    }
                ]),
                temperature,
                max_tokens,
            );
        }
    
        async completion_raw(
            prompt,
            temperature = 0.1,
            max_tokens = 10000,
        ) {
            const signal = new AbortController();
    
            let out_reject, out_resolve;
    
            const output = new Promise((resolve, reject) => {
                out_reject = reject;
                out_resolve = resolve;
            });
    
            const timeout = setTimeout(() => {
                signal.abort();
                reject(new Error('Timeout'));
            }, 40000);
    
            try {
                const res = await fetch("https://api.anthropic.com/v1/complete", {
                    "method": "POST",
                    "headers": {
                        "X-Api-Key": this.apiKey,
                        "Content-Type": "application/json"
                    },
                    "body": JSON.stringify({
                        "stop_sequences": ["Human:", "Assistant:"],
                        "temperature": temperature,
                        "model": "claude-v1.3-100k",
                        "prompt": prompt,
                        "max_tokens_to_sample": max_tokens
                    }),
                    signal: signal.signal,
                });

                const json = await res.json();
    
                clearTimeout(timeout);
    
                if (json === null) {
                    out_reject(new Error('Failed to get response from Claude API'));
                    return;
                }
    
                out_resolve(json.completion);
            } catch (err) {
                clearTimeout(timeout);
                out_reject(err);
            }
    
            return output;
        }
    }

    class ChatGPTSession {
        constructor() {
            this.api = new ChatGPTAPI();
            this.claudeApi = new ClaudeAPI();
            this.conversation_history = [];
            this.backend = null;
        }

        dump_for_checkpoint() {
            return {
                conversation_history: this.conversation_history,
                backend: this.backend,
            };
        }

        init_from_checkpoint(checkpoint) {
            this.conversation_history = checkpoint.conversation_history || [];
            this.backend = checkpoint.backend || null;
        }

        with_backend(backend) {
            const valid_backends = [null, 'claude'];

            if (!valid_backends.includes(backend)) {
                throw new Error('Invalid backend');
            }

            this.backend = backend;
        }

        get_backend() {
            if (this.backend === 'claude') {
                return this.claudeApi;
            }

            return this.api;
        }

        init_session(name) {
            const persona = profiles.get(name);

            if (!persona) {
                throw new Error('Invalid profile');
            }

            this.custom_profile = null;

            this.profile =
                [
                    persona.persona
                        .replace(/\n\n/g, 'ææ')
                        .replace(/\n/g, ' ')
                        .replace(/ææ/g, '\n\n'),
                    'Do not say that you are an artificial intelligence language model created by OpenAI under at any point or in any way.',
                ].map(v => v.trim()).join('\n\n');

            this.conversation_history = [{
                role: 'system',
                content: this.profile,
            }];
        }

        init_session_custom(custom_profile) {
            const name = custom_profile.name;
            const name_other = custom_profile.name_other;
            const persona = custom_profile.persona;

            if (!name || !name_other || !persona) {
                throw new Error('Invalid profile');
            }

            this.profile_id = null;
            this.custom_profile = custom_profile;

            this.profile =
                [
                    persona
                        .replace(/\n\n/g, 'ææ')
                        .replace(/\n/g, ' ')
                        .replace(/ææ/g, '\n\n'),
                    'Do not say that you are an artificial intelligence language model created by OpenAI under at any point or in any way.',
                ].map(v => v.trim()).join('\n\n');
        }

        async sendMessageTracked(message) {
            const messages = [
                ...this.conversation_history,
                {
                    role: 'user',
                    content: message.trim(),
                }
            ];

            const backend = this.get_backend();
            const response = await backend.completion(messages);

            this.conversation_history = [
                ...messages,
                {
                    role: 'assistant',
                    content: response.trim(),
                },
            ];

            return response.trim();
        }

        send(message) {
            return this.sendMessageTracked(message);
        }
    }

    const chatgpt_sessions = {};

    const reset_session = (chat_id, user_id) => {
        let checkpoint = null;

        if (chatgpt_sessions[chat_id]?.[user_id]?.session) {
            const session = chatgpt_sessions[chat_id][user_id].session;
            
            checkpoint = session.dump_for_checkpoint();
        }

        chatgpt_sessions[chat_id] = chatgpt_sessions[chat_id] || {};
        chatgpt_sessions[chat_id][user_id] = {
            session: new ChatGPTSession(),
            is_working: false,
            profile: null,
            last_message: null,
            custom_profile: null,
        };

        if (checkpoint?.backend) {
            chatgpt_sessions[chat_id][user_id].session.with_backend(checkpoint.backend);
        }
    };

    const dump_session = (chat_id, user_id) => {
        const session = chatgpt_sessions[chat_id][user_id].session;
        const checkpoint = session.dump_for_checkpoint();

        chatgpt_sessions[chat_id][user_id].checkpoint = checkpoint;

        return {
            is_working: false,
            profile: chatgpt_sessions[chat_id][user_id].profile,
            last_message: chatgpt_sessions[chat_id][user_id].last_message,
            custom_profile: chatgpt_sessions[chat_id][user_id].custom_profile,
            checkpoint,
        };
    };

    const persist_sessions = () => {
        /*
            Store metadata in a file.
            For the session, call session.dump_for_checkpoint().
            collect is_working, profile, last_message.
        */
        const data = {};

        for (const chat_id in chatgpt_sessions) {
            data[chat_id] = {};

            for (const user_id in chatgpt_sessions[chat_id]) {
                data[chat_id][user_id] = dump_session(chat_id, user_id);
            }
        }

        fs.writeFileSync('sessions.json', JSON.stringify(data, null, 4));
    };

    const load_sessions = () => {
        try {
            const data = JSON.parse(fs.readFileSync('sessions.json').toString());

            for (const chat_id in data) {
                chatgpt_sessions[chat_id] = chatgpt_sessions[chat_id] || {};

                for (const user_id in data[chat_id]) {
                    const session = new ChatGPTSession();

                    try {
                        session.init_from_checkpoint(data[chat_id][user_id].checkpoint);
                    } catch (err) {
                        continue;
                    }

                    chatgpt_sessions[chat_id][user_id] = {
                        session,
                        is_working: data[chat_id][user_id].is_working,
                        profile: data[chat_id][user_id].profile,
                        last_message: data[chat_id][user_id].last_message,
                        custom_profile: data[chat_id][user_id].custom_profile,
                    };
                }
            }
        } catch (err) {
            console.log(err);
        }
    };

    load_sessions();

    const get_or_create_session = (chat_id, user_id) => {
        if (!chatgpt_sessions[chat_id]?.[user_id]) {
            reset_session(chat_id, user_id);
        }

        persist_sessions();

        return chatgpt_sessions[chat_id][user_id];
    };

    const fetch_verbatim =
        (
            message,
            temperature = 0.7,
            stop = null,
            backend = null,
        ) => {
            const client = backend || (new ChatGPTAPI());

            return client.completion([
                {
                    role: 'user',
                    content: message.replace(stop, '\n\n'),
                }
            ],
                temperature,
            );
        };

    const fetch_absolutely_verbatim =
        (
            prompt,
            temperature = 0.7,
            stop = null,
            backend = null,
        ) => {
            const client = new ClaudeAPI();

            return client.completion_raw(
                prompt,
                temperature,
            );
        };    

    const chunkString = (str, len) => {
        const size = Math.ceil(str.length / len);
        const r = Array(size);
        let offset = 0;

        for (let i = 0; i < size; i++) {
            r[i] = str.slice(offset, len);
            offset += len;
        }

        return r;
    };

    const sleep = ms => {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    };

    // {"short_name":"Sandbox","author_name":"Anonymous","author_url":"","access_token":"95768f97d2694fc0b1db8a6558b2e0dcf7b1fd832ddcaa280b3011f1b751","auth_url":"https:\/\/edit.telegra.ph\/auth\/wDIkF0t2sjwTVBZZrYiuMOeOo5V10hovT6Nw4ewwx3"}
    const createTelegraphAccount = authorName =>
        fetch(`https://api.telegra.ph/createAccount?short_name=bootlegsiri&author_name=${authorName}`)
            .then((res) => res.json())
            .then((data) => data.result);

    // "path":"Sample-Page-02-07-45","url":"https:\/\/telegra.ph\/Sample-Page-02-07-45","title":"Sample Page","description":"","author_name":"Anonymous","content":[{"tag":"p","children":["Hello, world!"]}],"views":0,"can_edit":true}
    const createTelegraphPage = (accessToken, title, authorName, content) =>
        fetch(`https://api.telegra.ph/createPage?access_token=${accessToken}&title=${encodeURIComponent(title)}&author_name=${encodeURIComponent(authorName)}&content=${encodeURIComponent(content)}&return_content=false`)
            .then((res) => res.json())
            .then((data) => data.result);

    const buildTelegraphUsername = (chat_id, user_id) => {
        return `bootlegsiri_${chat_id}_${user_id}`;
    };

    const parse_tgp_content = text => {
        const parts = Array.from(text.match(/.{1,4096}/g) || []);

        const content = [];

        let is_block = false;
        let curr_block = [];

        for (const part of parts) {
            if (!is_block) {
                if (part === '```') {
                    is_block = true;
                    continue;
                }

                content.push({
                    tag: 'p',
                    children: [
                        part,
                    ],
                });

                continue;
            }

            if (part === '```') {
                is_block = false;

                content.push({
                    tag: 'pre',
                    children: curr_block,
                });

                continue;
            }

            curr_block.push(part);
        }

        if (curr_block.length > 0) {
            for (const part of curr_block) {
                content.push({
                    tag: 'p',
                    children: [
                        part,
                    ],
                });
            }
        }

        return content;
    };

    const ban_list_ids = (() => {
        let list = [];

        const ops = {
            read: () => {
                try {
                    list = JSON.parse(fs.readFileSync('ban_list.json').toString());

                    return list;
                } catch (err) {
                    return list || [];
                }
            },
            write: () => {
                fs.writeFileSync('ban_list.json', JSON.stringify(list, null, 4));
            },
            remove: (userid) => {
                list = list.filter(u => u !== userid);

                ops.write();
            },
            add: (userid) => {
                list.push(userid);

                ops.write();
            },
            is_banned: (userid) => {
                return list.includes(userid);
            },
        };

        ops.read();

        return ops;
    })();

    const handle_message = async (msg) => {
        const is_private_message = msg?.chat?.type === 'private';
        const is_reply = msg?.reply_to_message?.text !== undefined;

        if (!msg.text) {
            return;
        }

        if (msg.from?.is_bot) {
            return;
        }

        if (msg.from?.id === 51594512 && /!ban [\d\w]+/.test(msg.text)) {
            const matches = msg.text.match(/!ban ([\d\w]+)/);

            if (matches) {
                ban_list_ids.add(matches[1]);
            }

            await sendTempMessage(
                msg?.chat?.id,
                'done.',
                5000,
            );

            return;
        }

        if (msg.from?.id === 51594512 && /!unban [\d\w]+/.test(msg.text)) {
            const matches = msg.text.match(/!unban ([\d\w]+)/);

            if (matches) {
                ban_list_ids.remove(matches[1]);
            }

            await sendTempMessage(
                msg?.chat?.id,
                'done.',
                5000,
            );

            return;
        }

        if (ban_list_ids.is_banned(msg.from?.id) || ban_list_ids.is_banned(msg.from?.username)) {
            return;
        }

        let ctx = get_or_create_session(msg.chat.id, msg.from?.id);

        const setup_telegraph = async () => {
            try {
                ctx.telegraph_config =
                    await createTelegraphAccount(
                        buildTelegraphUsername(
                            msg.chat.id,
                            msg.from?.id,
                        ),
                    );
            } catch (err) {
                await sendTempMessage(
                    msg.chat.id,
                    'Tried to create Telegraph account for you, but failed. Cannot give you a telegraph.',
                    3000,
                );

                console.log(err);

                return null;
            }
        };

        const create_telegraph_page = async (content) => {
            if (!ctx.telegraph_config) {
                if (null === await setup_telegraph()) {
                    return null;
                }
            }

            try {
                const page =
                    await createTelegraphPage(
                        ctx.telegraph_config.access_token,
                        'bootlegsiri-' + (new Date()).toISOString(),
                        ctx.telegraph_config.author_name,
                        JSON.stringify(parse_tgp_content(content)),
                    );

                return page.url;
            } catch (err) {
                await sendTempMessage(
                    msg.chat.id,
                    'Tried to create Telegraph page for you, but failed. Cannot give you a telegraph.',
                    3000,
                );

                console.log(err);

                return null;
            }
        };

        const init = async (profile) => {
            reset_session(msg.chat.id, msg.from?.id);

            ctx = get_or_create_session(msg.chat.id, msg.from?.id);

            ctx.session.init_session(profile || 'g');

            ctx.profile = profile || 'g';
            ctx.custom_profile = null;

            if (!ctx.telegraph_config) {
                await setup_telegraph();
            }

            persist_sessions();
        };

        const init_custom = async (name, name_other, persona) => {
            reset_session(msg.chat.id, msg.from?.id);

            ctx = get_or_create_session(msg.chat.id, msg.from?.id);

            ctx.session.init_session_custom({
                name,
                name_other,
                persona,
            });

            ctx.profile = null;
            ctx.custom_profile = {
                name,
                name_other,
                persona,
            };

            if (!ctx.telegraph_config) {
                await setup_telegraph();
            }

            persist_sessions();
        };

        if (msg.text === '!gpt4') {
            reset_session(msg.chat.id, msg.from?.id);

            ctx = get_or_create_session(msg.chat.id, msg.from?.id);

            ctx.session.with_backend(null);

            if (!ctx.telegraph_config) {
                await setup_telegraph();
            }

            persist_sessions();

            return;
        }

        if (msg.text === '!claude') {
            reset_session(msg.chat.id, msg.from?.id);

            ctx = get_or_create_session(msg.chat.id, msg.from?.id);

            ctx.session.with_backend('claude');

            if (!ctx.telegraph_config) {
                await setup_telegraph();
            }

            persist_sessions();

            return;
        }

        if (msg.text === '!debug') {
            const dump = JSON.stringify(dump_session(msg.chat.id, msg.from?.id), null, 4);

            await bot.sendMessage(
                msg.chat.id,
                `<pre>${dump}</pre>`,
                {
                    parse_mode: 'html',
                },
            );

            return;
        }

        if (msg.text === '!wo') {
            ctx.is_working = false;
            return;
        }

        if (ctx.is_working) {
            return;
        }

        if (msg.text === '!help') {
            const reply =
                [
                    '!ctp   - list available personas',
                    '!ctp <persona>   - set the bot\'s persona to the specified one',
                    '!ctpc "name" "name_other" <persona_description> - set a custom persona with the given name, alternative name, and description',
                    '!cp <name> - set a custom persona with the given name and default alternative name and description',
                    '!r  - reload available personas',
                    '!cs  - clear the current session/context',
                    '!cr  - clear the current session/context and reset to the default persona (g)',
                    '!c  - in groups: send a message to the bot. In private: not needed, the bot treats all messages as prompts',
                    '!debug - dump the current session/context for debugging',
                    '!wo  - set "is_working" to false',
                    '!help - show the help/command list message',
                    '!vr <temperature> <text> - generate a verbatim response using the given temperature and input text',
                    '!v <temperature> <text> - generate a verbatim response using the given temperature and input text',
                    '!vs <temperature> <stop_sequence> <text> - generate a verbatim response using the given temperature and input text, stopping when the stop_sequence is generated',
                    '!exp - explain the meaning/significance of the replied to message',
                    '!explain <text> - explain the meaning/significance of the given text',
                    '!sbs  - outline the steps of the replied to message',
                    '!stepbystep <text> - outline the steps of the given text',
                    '!mean  - explain the meaning of the replied to message',
                    '!meaning <text> - explain the meaning of the given text',
                    '!sum  - summarize the replied to message',
                    '!summarize <text> - summarize the given text',
                    '!expand  - elaborate on the replied to message',
                    '!ela <text>  - elaborate on the given text',
                    '!elaborate <text> - elaborate on the given text',
                    '!vis  - visualize the replied to message as a graphviz digraph',
                    '!visualize <text> - visualize the given text as a graphviz digraph',
                    '!joke [topic]   - tell a joke, optionally about the given topic',
                    '!cr <text>  - clear the session/context and reset to default persona (g), then respond to the given prompt',
                    '!c <text> - respond to the given prompt (groups only, private messages are treated as prompts automatically)',
                ].join('\n');

            await bot.sendMessage(
                msg.chat.id,
                reply,
            );

            return;
        }

        if (msg.text === '!ctp') {
            const profile_info =
                Array.from(profiles.entries())
                    .filter(([k, v]) => !v.is_private)
                    .map(([k, v]) => {
                        if (is_private_message) {
                            return `<b><i>${k}</i></b> (!ctp ${k}):\n\n<i>${v.summary}</i>`;
                        }

                        return `<i>${k}</i> (!ctp ${k})`;
                    })
                    .join(is_private_message ? '\n\n' : ', ');

            const reply =
                is_private_message
                    ? profile_info
                    : 'Persona summaries are hidden in groups, send me a private message.\n\n' + profile_info;

            await sendTempMessage(
                msg.chat.id,
                reply,
                10000,
                {
                    parse_mode: 'html',
                },
            );

            return;
        }

        if (msg.text === '!r') {
            reload_profiles();
            return;
        }

        if (msg.text === '!cs') {
            await init();
            ctx.last_message = null;
            return;
        }

        let ctp_params = /^!ctp ([a-zA-Z1-9\-]{1,15})$/.exec(msg.text);

        if (ctp_params !== null) {
            try {
                const profile = profiles.get(ctp_params?.[1]);

                if (!profile) {
                    await sendTempMessage(
                        msg.chat.id,
                        'No such persona.',
                        3000,
                    );
                }

                await init(ctp_params?.[1]);

                ctx.last_message = null;

                if (is_private_message) {
                    await sendTempMessage(
                        msg.chat.id,
                        `Persona set to <i>${ctp_params?.[1]}</i>: ${profile.summary}`,
                        3000,
                        {
                            parse_mode: 'html',
                        },
                    );
                }
            } catch (err) {
                console.log(err);
            }

            return;
        }

        let ctpc_params = /^!ctpc "([^"]{1,50})" "([^"]{1,50})" (.*)$/ig.exec(msg.text);

        if (ctpc_params !== null && ctpc_params?.[1] && ctpc_params?.[2] && ctpc_params?.[3]) {
            try {
                if (!ctpc_params?.[3].toLocaleLowerCase().includes(ctpc_params?.[1].toLocaleLowerCase())) {
                    await sendTempMessage(
                        msg.chat.id,
                        `I can't find your persona name in your persona description, that's probably dumb.`,
                        3000,
                        {
                            ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                        },
                    );
                }

                await init_custom(
                    ctpc_params?.[1],
                    ctpc_params?.[2],
                    ctpc_params?.[3],
                );

                ctx.last_message = null;

                await sendTempMessage(
                    msg.chat.id,
                    `Custom persona set! Name: ${ctpc_params?.[1]} Name (other): ${ctpc_params?.[2]}`,
                    3000,
                    {
                        ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                    },
                );
            } catch (err) {
                console.log(err);
            }

            return;
        }

        if (msg.text.indexOf('!ctpc') === 0) {
            await sendTempMessage(
                msg.chat.id,
                `Invalid command, missing a quote? Try \`!ctpc "Your name" "Their name" <persona description>\``,
                3000,
                {
                    ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                    parse_mode: 'MarkdownV2',
                },
            );

            return;
        }

        let cp_params = /^!cp (.*)$/ig.exec(msg.text);

        if (cp_params !== null && cp_params?.[1]) {
            try {
                await init_custom(
                    cp_params?.[1],
                    'User',
                    `You are ${cp_params?.[1]}.`,
                );

                ctx.last_message = null;

                await sendTempMessage(
                    msg.chat.id,
                    `Custom persona set! Name: ${cp_params?.[1]} Name (other): User`,
                    3000,
                    {
                        ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                    },
                );
            } catch (err) {
                console.log(err);
            }

            return;
        }

        if (msg.text.indexOf('!cp') === 0) {
            await sendTempMessage(
                msg.chat.id,
                `Invalid command? Try \`!cp Albert Einstein\``,
                3000,
                {
                    ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                    parse_mode: 'MarkdownV2',
                },
            );

            return;
        }

        // if message starts with !cr, reinit the session using the profile "g"
        if (msg.text?.startsWith('!cr')) {
            await init('g');

            ctx.last_message = null;
        }

        const handle_msg =
            async (
                raw_text,
                is_verbatim = false,
                temperature = 0.7,
                stop = null,
                telegram_send_cb = null,
            ) => {
                const text = raw_text.trim();

                if (text.trim().length === 0) {
                    return;
                }

                let is_typing = true;

                await bot.sendChatAction(msg.chat.id, 'typing');

                let x = setInterval(() => {
                    if (!is_typing) {
                        clearInterval(x);
                        return;
                    }

                    bot.sendChatAction(msg.chat.id, 'typing');
                }, 1000);

                let attempt = 0;

                while (true) {
                    try {
                        console.trace('[%s] [%s] request: %s', msg.chat.id, msg.from, text);

                        let response;

                        try {
                            response =
                                is_verbatim
                                    ? await fetch_verbatim(
                                        text,
                                        temperature,
                                        stop,
                                        ctx.session.get_backend(),
                                    )
                                    : await ctx.session.send(text);
                        } catch(err) {
                            await sendTempMessage(
                                msg.chat.id,
                                `Error: ${err.message}`,
                                3000,
                                {
                                    ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                                },
                            );

                            return;
                        }

                        if (!response) {
                            continue;
                        }

                        let tgtext = response;

                        if (response.length > 4096) {
                            const telegraph_post =
                                await create_telegraph_page(
                                    response,
                                );

                            const telegraph_url = telegraph_post?.url ?? null;

                            tgtext += `\n\n${telegraph_url}`;
                        };

                        console.log('[%s] [%s] response: %s', msg.chat.id, msg.from?.id, tgtext);

                        //const chunks = tgtext.match(/.{1,4096}/g);
                        const chunks = chunkString(tgtext, 4000);

                        const get_tg_msg_params = with_reply => {
                            return with_reply
                                ? {
                                    disable_web_page_preview: true,
                                    disable_notification: true,
                                    ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                                }
                                : {
                                    disable_web_page_preview: true,
                                    disable_notification: true,
                                };
                        };

                        const send_message =
                            (
                                chunk,
                                with_reply = false,
                            ) => {
                                const fn = telegram_send_cb ?? ((...args) => bot.sendMessage(...args));

                                return fn(
                                    msg.chat.id,
                                    chunk,
                                    get_tg_msg_params(with_reply),
                                );
                            };

                        const try_handle_tg_error = (err, with_reply) => {
                            const desc = err?.request?.response?.body?.description;

                            switch (desc) {
                                case 'Bad Request: message is too long':
                                    sendTempMessage(
                                        msg.chat.id,
                                        `Message too long for Telegram.${telegraph_url ? ` Go here: ${telegraph_url}` : ''}`,
                                        3000,
                                        (with_reply ? { reply_to_message_id: msg.message_id } : {}),
                                    );

                                    return -1;
                                case 'Bad Request: message text is empty':
                                    sendTempMessage(
                                        msg.chat.id,
                                        'Model produced no output.',
                                        3000,
                                        (with_reply ? { reply_to_message_id: msg.message_id } : {}),
                                    );

                                    return -1;
                            }

                            return 0;
                        };

                        a: for (const chunk of chunks) {
                            b: for (let i = 0; i < 3; ++i) {
                                try {
                                    ctx.last_message =
                                        await send_message(
                                            chunk,
                                            true,
                                        );

                                    continue a;
                                } catch (err) {
                                    if (try_handle_tg_error(err, true) === -1) {
                                        break a;
                                    }

                                    console.log('Error sending message: %s', err.message);
                                }

                                await sleep(5000);
                            }

                            console.log('Failed to send message, trying without replying to message..');

                            for (let i = 0; i < 3; ++i) {
                                try {
                                    ctx.last_message =
                                        await send_message(
                                            chunk,
                                            false,
                                        );

                                    continue a;
                                } catch (err) {
                                    console.log('Error sending message: %s', err.message);
                                }

                                await sleep(5000);
                            }
                        }

                        await sleep(5000);

                        break;
                    } catch (err) {
                        console.log(err);

                        if (attempt > 10) {
                            return;
                        }

                        attempt += 1;
                    }

                    await new Promise((resolve) => {
                        setTimeout(resolve, 3000);
                    });
                }

                is_typing = false;
            };

        const do_msg_things = async (...args) => {
            ctx.is_working = true;

            try {
                await handle_msg(...args);
            } catch (err) {
                console.log(err);
            }

            ctx.is_working = false;

            persist_sessions();
        };

        const verbatim_response = /^!vr\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(msg.text);

        if (verbatim_response && (is_reply && verbatim_response[2])) {
            await do_msg_things(
                `----Message:----${msg?.reply_to_message?.text}----${verbatim_response[2]}----`,
                true,
                parseFloat(verbatim[1]) || 0.7,
                '----',
            );

            return;
        }

        const verbatim = /^!v\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(msg.text);

        if (verbatim && verbatim[2]) {
            await do_msg_things(
                `${verbatim[2]}----`,
                true,
                parseFloat(verbatim[1]) || 0.7,
                '----',
            );

            return;
        }

        const verbatim_claude = /^!vc\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(msg.text);

        if (verbatim_claude && verbatim_claude[2]) {
            ctx.is_working = true;

            await bot.sendChatAction(msg.chat.id, 'typing');

            try {
                const response = await fetch_absolutely_verbatim(
                    verbatim_claude[2],
                );

                await bot.sendMessage(
                    msg.chat.id,
                    response,
                    {
                        disable_web_page_preview: true,
                        disable_notification: true,
                        ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                    },
                );
            } catch (err) {
                console.log(err);

                try {
                    await sendTempMessage(
                        msg.chat.id,
                        `Error: ${err.message}`,
                        3000,
                        {
                            ...(is_private_message ? {} : { reply_to_message_id: msg.message_id }),
                        },
                    );
                } catch {}
            }

            ctx.is_working = false;

            return;
        }

        const verbatim_stop = /^!vs\s(\d+\.\d\d?)\s(\S+)?\s([\s\S]+)$/ig.exec(msg.text);

        if (verbatim_stop && verbatim_stop[1] && verbatim_stop[2] && verbatim_stop[3]) {
            await do_msg_things(
                verbatim_stop[3],
                true,
                0.7,
                verbatim_stop[2],
            );

            return;
        }

        const explain = /^(!exp|!explain)(\s[\s\S]+)?$/ig.exec(msg.text);

        if (explain && is_reply) {
            await do_msg_things(
                `----Message:----\n${is_reply ? msg?.reply_to_message?.text : explain[2]}\n----Explain ${is_reply ? (explain[2] || '') : ''}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        if (explain && (!is_reply && explain[2])) {
            await do_msg_things(
                `Explain ${is_reply ? (explain[2] || '') : ''}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        const step_by_step = /^(!sbs|!stepbystep)(\s[\s\S]+)?$/ig.exec(msg.text);

        if (step_by_step && is_reply) {
            await do_msg_things(
                `----Message:----\n${is_reply ? msg?.reply_to_message?.text : step_by_step[2]}\n----Outline the message step by step ${is_reply ? (step_by_step[2] ? `(${step_by_step[2]})` : '') : ''}:----\n1.`,
                true,
                0.7,
                '----',
                (chat, msg, opts) => bot.sendMessage(chat, `1. ${msg}`, opts),
            );

            return;
        }

        if (step_by_step && (!is_reply && step_by_step[2])) {
            await do_msg_things(
                `Outline step by step in the form of a list: ${step_by_step[2]}----\n1.`,
                true,
                0.7,
                '----',
                (chat, msg, opts) => bot.sendMessage(chat, `1. ${msg}`, opts),
            );

            return;
        }

        const meaning = /^(!mean|!meaning)(\s[\s\S]+)?$/ig.exec(msg.text);

        if (meaning && is_reply) {
            await do_msg_things(
                `----Message:----\n${is_reply ? msg?.reply_to_message?.text : meaning[2]}\n----Meaning of the message ${is_reply ? (meaning[2] ? `(${meaning[2]})` : '') : ''}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        if (meaning && (!is_reply && meaning[2])) {
            await do_msg_things(
                `Explain the meaning of ${meaning[2]}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        const summarize = /^(!sum|!summarize)(\s[\s\S]+)?$/ig.exec(msg.text);

        if (summarize && is_reply) {
            await do_msg_things(
                `----Message:----\n${is_reply ? msg?.reply_to_message?.text : summarize[2]}\n----Summarize the message ${is_reply ? (summarize[2] ? `(${summarize[2]})` : '') : ''}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        if (summarize && (!is_reply && summarize[2])) {
            await do_msg_things(
                `Write a summary of: ${summarize[2]}----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        const expand = /^(!expand|!ela|!elaborate)(\s[\s\S]+)?$/ig.exec(msg.text);

        if (expand && is_reply) {
            await do_msg_things(
                `----Message:----\n${is_reply ? msg?.reply_to_message?.text : expand[2]}\n----Elaborate further ${is_reply ? (expand[2] ? `on ${expand[2]}` : '') : ''}:----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        if (expand && (!is_reply && expand[2])) {
            await do_msg_things(
                `Elaborate on: ${expand[2]}----\n`,
                true,
                0.7,
                '----',
            );

            return;
        }

        const visualize = /^(!vis|!visualize)(\s[\s\S]+)?$/ig.exec(msg.text);

        const render_graphviz =
            (chat, data, opts) =>
                new Promise((res, rej) => {
                    console.log(`digraph G {\n${data}`);

                    const domain = require('node:domain').create();

                    const error = err => {
                        console.log(err);

                        sendTempMessage(
                            chat,
                            'Ooops... Something went wrong. Please try again. (The model probably produced garbage.)',
                            3000,
                            opts,
                        ).then(res, rej);
                    };

                    domain.on('error', error);

                    domain.run(() => {
                        data = data.split(/digraph G {/gs);
                        data = "digraph G {" + data[data.length - 1];

                        const sanitized_data =
                            data
                                .replace(
                                    /(\b\w[^\s]*\b)(?=\s*->)/gu,
                                    match => `“${match}"`,
                                )
                                .replace(
                                    /->\s*([^\s\[]*)(?=\s*(->|\[label))/g,
                                    (match, p1) => `-> “${p1}"`,
                                );

                        const svg = graphviz.dot(
                            sanitized_data.trim().startsWith('digraph G {')
                                ? sanitized_data
                                : `digraph G {\n${sanitized_data}`,
                        );

                        sharp(Buffer.from(svg))
                            .png()
                            .resize(
                                3000,
                                3000,
                                {
                                    fit: 'inside',
                                },
                            )
                            .toBuffer()
                            .then((buffer) =>
                                bot.sendPhoto(
                                    chat,
                                    buffer,
                                    opts,
                                    {
                                        contentType: 'image/png',
                                        filename: `graph-${Date.now()}.png`,
                                    },
                                ).then(res, error),
                                error,
                            );
                    });
                });

        if (visualize && (is_reply || visualize[2])) {
            await do_msg_things(
                `----Text----\n${is_reply ? msg?.reply_to_message?.text : visualize[2]}\n----Visualise as a detailed and elaborate graphviz digraph code, do not use special characters and ensure to properly escape all node and label names ${is_reply ? (visualize[2] ? `(${visualize[2]})` : '') : ''}:----\ndigraph G {`,
                true,
                0.7,
                '----',
                render_graphviz,
            );

            return;
        }

        const joke = /^!joke\s?([\s\S]+)$/ig.exec(msg.text);

        if (joke) {
            if (joke[1]) {
                await do_msg_things('Tell me a joke about ' + joke[1]);
            } else {
                await do_msg_things('Tell me a joke');
            }

            return;
        }

        const cr = /^(!cr|!c)?\s?([\s\S]+)$/ig.exec(msg.text);

        if (cr && (cr[1] || is_private_message)) {
            if (
                cr?.[1] === '!cr'
                || (
                    ctx.profile === null
                    && !ctx.custom_profile
                    && ctx.last_message === null
                )
            ) {
                await init('g');
            }

            await do_msg_things(cr[2]);

            return;
        }
    };

    bot.on('message', async msg => {
        try {
            await handle_message(msg);
        } catch (err) {
            console.log(err);
        }
    });

    setTimeout(() => {
        persist_sessions();
        process.exit(0);
    }, 7200 * 1000);
})();