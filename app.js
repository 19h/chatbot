const fs = require('fs');
const path = require('path');

const sharp = require('sharp');
const tiktoken = require('@dqbd/tiktoken');

(async () => {
    const TelegramBot = require('node-telegram-bot-api');
    const { Graphviz } = await import('@hpcc-js/wasm/graphviz');

    const graphviz = await Graphviz.load();

    const token = process.env.TELEGRAM_TOKEN;

    const bot = new TelegramBot(token, { polling: true });

    const chill_send_message = (() => {
        const MAX_MESSAGES_PER_SECOND = 25;
        const MAX_MESSAGES_PER_CHAT_PER_SECOND = 1;

        const queue = [];

        let sent_this_second = 0;
        let process_queue_id = null;

        const clear_intervals = () => {
            clearInterval(process_queue_id);

            process_queue_id = null;
        };

        const set_intervals = () => {
            process_queue_id = setInterval(process_queue, 1200);
        };

        const send_message = (chat_id, text, options = {}) => {
            return new Promise((resolve, reject) => {
                queue.push({ chat_id, text, options, resolve, reject });

                if (process_queue_id === null && queue.length === 1) {
                    process_queue();
                }

                if (process_queue_id === null) {
                    clear_intervals();
                    set_intervals();
                }

                return;
            });
        };

        const process_queue = () => {
            if (queue.length === 0) {
                clear_intervals();

                return;
            }

            const epoch_chats = new Map();
            const messages = [];

            const epoch_queue = queue.slice(0);
            
            queue.splice(0);

            for (let i = 0; i < epoch_queue.length; i++) {
                const { chat_id, text, options, resolve, reject } = epoch_queue[i];

                const chat_messages_in_epoch = epoch_chats.get(chat_id) || 0;

                const chat_cap_exceeded = chat_messages_in_epoch >= MAX_MESSAGES_PER_CHAT_PER_SECOND;
                const global_cap_exceeded = messages.length >= MAX_MESSAGES_PER_SECOND;

                if (chat_cap_exceeded || global_cap_exceeded) {
                    queue.push({ chat_id, text, options, resolve, reject });

                    continue;
                }

                epoch_chats.set(chat_id, chat_messages_in_epoch + 1);

                messages.push({ chat_id, text, options, resolve, reject });
            }

            if (queue.length === 0 && messages.length === 0) {
                clear_intervals();

                return;
            }

            for (let i = 0; i < messages.length; i++) {
                const { chat_id, text, options, resolve, reject } = messages[i];

                bot.sendMessage(chat_id, text, options)
                    .then(resolve)
                    .catch(reject);
            }
        };

        return send_message;
    })();

    const sendTempMessage = (chatId, text, ms, options = {}) =>
        chill_send_message(chatId, text, options)
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

    const tokenizer_gpt4 = tiktoken.encoding_for_model('gpt-4-0314');
    
    //const tokenizer_claude =
    //    new tiktoken.Tiktoken(
    //        fs.readFileSync('./claude-v1-tokenization.tiktoken', 'utf8'),
    //        {
    //            "<EOT>": 0,
    //            "<META>": 1,
    //            "<META_START>": 2,
    //            "<META_END>": 3,
    //            "<SOS>": 4,
    //        }
    //    )

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

        async copilotStreamed(url, opts) {
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

        async check_message_tokens(messages) {
            const text = messages.map(message => message.content).join('');
            const token_count = tokenizer_gpt4.encode(text).length;

            const gpt4_token_count = 8000;

            return {
                token_count,
                token_delta: gpt4_token_count - token_count,
            };
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

                out_reject(new Error('Timeout'));
            }, 40000);

            try {
                const copstr = this.copilotStreamed(
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

        async check_message_tokens(messages) {
            const text = messages.map(message => message.content).join('');
            const token_count = tokenizer_gpt4.encode(text).length;

            const gpt4_token_count = 100_000;

            return {
                token_count, // wrong but whatever
                token_delta: gpt4_token_count - token_count,
            };
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
                out_reject(new Error('Timeout'));
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

    class UserConversation {
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

        init_conversation(name) {
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

        init_conversation_custom(custom_profile) {
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

    class ChatSession {
        constructor(chat_id, user_id) {
            this.chat_id = String(chat_id);
            this.user_id = String(user_id);

            this.ensure_session_dir();

            this.ctx = this.load_session() || this.reset_session();
        }

        ensure_session_dir() {
            const sessions_dir = path.join(__dirname, 'sessions', this.user_id);

            if (fs.existsSync(sessions_dir)) {
                return;
            }

            fs.mkdirSync(sessions_dir, { recursive: true });
        }

        reset_session() {
            let checkpoint = null;

            if (this.ctx?.conversation) {
                const conversation = this.ctx.conversation;

                checkpoint = conversation.dump_for_checkpoint();
            }

            this.ctx = {
                conversation: new UserConversation(),
                is_working: false,
                profile: null,
                last_message: null,
                mode: this.ctx.mode || null,
                custom_profile: null,
            };

            if (checkpoint?.backend) {
                this.ctx.conversation.with_backend(checkpoint.backend);
            }

            this.persist();

            return this.ctx;
        }

        load_session() {
            const session_path = path.join(__dirname, 'sessions', this.user_id, `${this.chat_id}.json`);

            if (!fs.existsSync(session_path)) {
                return null;
            }

            try {
                const data = JSON.parse(fs.readFileSync(session_path).toString());
                
                return this.deserialize(data);
            } catch (err) {
                console.log(err);
                return null;
            }
        }

        deserialize(data) {
            const conversation = new UserConversation();

            conversation.init_from_checkpoint(data.checkpoint);

            return {
                conversation,
                is_working: data.is_working,
                profile: data.profile,
                last_message: data.last_message,
                mode: data.mode,
                custom_profile: data.custom_profile,
            };
        }

        serialize() {
            return {
                is_working: this.ctx.is_working,
                profile: this.ctx.profile,
                last_message: this.ctx.last_message,
                custom_profile: this.ctx.custom_profile,
                mode: this.ctx.mode,
                checkpoint: this.ctx.conversation.dump_for_checkpoint(),
            };
        }

        persist() {
            const session_path =
                path.join(
                    __dirname,
                    'sessions',
                    this.user_id,
                    `${this.chat_id}.json`,
                );

            const data = this.serialize();

            fs.mkdirSync(path.dirname(session_path), { recursive: true });

            fs.writeFileSync(session_path, JSON.stringify(data, null, 4));
        }
    }

    const migrate_sessions = () => {
        try {
            const data = JSON.parse(fs.readFileSync('sessions.json').toString());

            fs.mkdirSync(path.join(__dirname, 'sessions'));

            for (const chat_id in data) {
                for (const user_id in data[chat_id]) {
                    const session = new ChatSession(chat_id, user_id);
                    const session_data = data[chat_id][user_id];

                    session.ctx.is_working = session_data.is_working;
                    session.ctx.profile = session_data.profile;
                    session.ctx.last_message = session_data.last_message;
                    session.ctx.custom_profile = session_data.custom_profile;

                    session.ctx.conversation.init_from_checkpoint(session_data.checkpoint);

                    session.persist();
                }
            }

            fs.renameSync('sessions.json', 'sessions.json.bak');

            console.log('Successfully migrated sessions');
        } catch (err) {}
    };

    migrate_sessions();

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

    const chunk_string = (str, len) => {
        const size = Math.ceil(str.length / len);
        const r = Array(size);
        let offset = 0;

        for (let i = 0; i < size; i++) {
            r[i] = str.slice(offset, offset + len);
            offset += len;
        }

        return r;
    };

    const sleep = ms => {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    };

    const createTelegraphAccount = authorName =>
        fetch(`https://api.telegra.ph/createAccount?short_name=bootlegsiri&author_name=${authorName}`)
            .then((res) => res.json())
            .then((data) => data.result);

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

    class BanList {
        constructor() {
            this.list = [];

            this.read();
        }

        read() {
            try {
                this.list = JSON.parse(fs.readFileSync('ban_list.json').toString());
            } catch (err) {
                this.list = [];
            }
        }

        write() {
            fs.writeFileSync('ban_list.json', JSON.stringify(this.list, null, 4));
        }

        remove(userid) {
            this.list = this.list.filter(u => u !== userid);

            this.write();
        }

        add(userid) {
            this.list.push(userid);

            this.write();
        }

        is_banned(userid) {
            return this.list.includes(userid);
        }
    }

    class ConversationFrame {
        constructor(chat_session, msg, ban_list) {
            this.chat_session = chat_session;

            this.msg = msg;

            this.ban_list = ban_list;
        }

        async setup_telegraph () {
            try {
                this.chat_session.ctx.telegraph_config =
                    await createTelegraphAccount(
                        buildTelegraphUsername(
                            this.msg.chat.id,
                            this.msg.from?.id,
                        ),
                    );
            } catch (err) {
                await sendTempMessage(
                    this.msg.chat.id,
                    'Tried to create Telegraph account for you, but failed. Cannot give you a telegraph.',
                    3000,
                );

                console.log(err);

                return null;
            }
        }

        async create_telegraph_page(content) {
            if (!this.chat_session.ctx.telegraph_config) {
                if (null === await this.setup_telegraph()) {
                    return null;
                }
            }

            try {
                const page =
                    await createTelegraphPage(
                        this.chat_session.ctx.telegraph_config.access_token,
                        'bootlegsiri-' + (new Date()).toISOString(),
                        this.chat_session.ctx.telegraph_config.author_name,
                        JSON.stringify(parse_tgp_content(content)),
                    );

                return page.url;
            } catch (err) {
                await sendTempMessage(
                    this.msg.chat.id,
                    'Tried to create Telegraph page for you, but failed. Cannot give you a telegraph.',
                    3000,
                );

                console.log(err);

                return null;
            }
        }

        async init(profile) {
            this.chat_session.reset_session();

            this.chat_session.ctx.conversation.init_conversation(
                profile || this.get_chat_profile(),
            );

            this.chat_session.ctx.profile = profile || this.get_chat_profile();
            this.chat_session.ctx.custom_profile = null;

            if (!this.chat_session.ctx.telegraph_config) {
                await this.setup_telegraph();
            }
        }

        async init_custom(name, name_other, persona) {
            this.chat_session.reset_session();

            this.chat_session.ctx.conversation.init_conversation_custom({
                name,
                name_other,
                persona,
            });

            this.chat_session.ctx.profile = null;
            this.chat_session.ctx.custom_profile = {
                name,
                name_other,
                persona,
            };

            if (!this.chat_session.ctx.telegraph_config) {
                await this.setup_telegraph();
            }
        }

        async process_command (
            raw_text,
            is_verbatim = false,
            temperature = 0.7,
            stop = null,
            telegram_send_cb = null,
        ) {
            const is_private_message = this.msg.chat?.type === 'private';

            const text = raw_text.trim();

            if (text.trim().length === 0) {
                return;
            }

            let is_typing = true;

            await bot.sendChatAction(this.msg.chat.id, 'typing');

            let y;
            let x = setInterval(() => {
                if (!is_typing) {
                    clearTimeout(x);
                    clearInterval(x);
                    return;
                }

                bot.sendChatAction(this.msg.chat.id, 'typing');
            }, 1000);

            y = setTimeout(() => {
                clearInterval(x);
            }, 30000);

            let attempt = 0;

            while (true) {
                try {
                    console.trace('[%s] [%s] request: %s', this.msg.chat.id, this.msg.from, text);

                    let response;

                    try {
                        response =
                            is_verbatim
                                ? await fetch_verbatim(
                                    text,
                                    temperature,
                                    stop,
                                    this.chat_session.ctx.conversation.get_backend(),
                                )
                                : await this.chat_session.ctx.conversation.send(text);
                    } catch(err) {
                        await sendTempMessage(
                            this.msg.chat.id,
                            `Error: ${err.message}`,
                            3000,
                            {
                                ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                            },
                        );

                        return;
                    }

                    if (!response) {
                        await sleep(5000 + Math.random() * 10000);

                        continue;
                    }

                    let tgtext = response;

                    if (response.length > 4000) {
                        const telegraph_post =
                            await this.create_telegraph_page(
                                response,
                            );

                        const telegraph_url = telegraph_post?.url ?? null;

                        tgtext += `\n\n${telegraph_url}`;
                    }

                    console.log('[%s] [%s] response: %s', this.msg.chat.id, this.msg.from?.id, tgtext);

                    //const chunks = tgtext.match(/.{1,4096}/g);
                    const chunks = chunk_string(tgtext, 4000);

                    const get_tg_msg_params = with_reply => {
                        return with_reply
                            ? {
                                disable_web_page_preview: true,
                                disable_notification: true,
                                ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
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
                            const fn = telegram_send_cb ?? ((...args) => chill_send_message(...args));

                            return fn(
                                this.msg.chat.id,
                                chunk,
                                get_tg_msg_params(with_reply),
                            );
                        };

                    const try_handle_tg_error = (err, with_reply) => {
                        const desc = err?.request?.response?.body?.description;

                        switch (desc) {
                            case 'Bad Request: message is too long':
                                sendTempMessage(
                                    this.msg.chat.id,
                                    //`Message too long for Telegram.${telegraph_url ? ` Go here: ${telegraph_url}` : ''}`,
                                    'Message too long for Telegram.',
                                    3000,
                                    (with_reply ? { reply_to_message_id: this.msg.message_id } : {}),
                                );

                                return -1;
                            case 'Bad Request: message text is empty':
                                sendTempMessage(
                                    this.msg.chat.id,
                                    'Model produced no output.',
                                    3000,
                                    (with_reply ? { reply_to_message_id: this.msg.message_id } : {}),
                                );

                                return -1;
                        }

                        return 0;
                    };

                    a: for (const chunk of chunks) {
                        b: for (let i = 0; i < 3; ++i) {
                            try {
                                this.chat_session.ctx.last_message =
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
                                this.chat_session.ctx.last_message =
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
                        is_typing = false;

                        return;
                    }

                    attempt += 1;
                }

                await sleep(3000);
            }

            is_typing = false;
        }

        async do_msg_things (
            raw_text,
            is_verbatim = false,
            temperature = 0.7,
            stop = null,
            telegram_send_cb = null,
        ) {
            this.chat_session.ctx.is_working = true;

            try {
                await this.process_command(
                    raw_text,
                    is_verbatim,
                    temperature,
                    stop,
                    telegram_send_cb,
                );
            } catch (err) {
                console.log(err);
            }

            this.chat_session.ctx.is_working = false;

            this.chat_session.persist();
        }

        get_chat_profile() {
            if (this.chat_session.ctx.mode === 'dev') {
                return 'copilot';
            }

            return 'g';
        }

        async process () {
            const is_private_message = this.msg.chat?.type === 'private';
            const is_reply = this.msg.reply_to_message?.text !== undefined;

            if (!this.msg.text) {
                return;
            }

            if (this.msg.from?.is_bot) {
                return;
            }

            if (this.msg.from?.id === 51594512 && /!ban \w+/.test(this.msg.text)) {
                const matches = this.msg.text.match(/!ban (\w+)/);

                if (matches) {
                    this.ban_list.add(matches[1]);
                }

                await sendTempMessage(
                    this.msg.chat?.id,
                    'done.',
                    5000,
                );

                return;
            }

            if (this.msg.from?.id === 51594512 && /!unban [\d\w]+/.test(this.msg.text)) {
                const matches = this.msg.text.match(/!unban ([\d\w]+)/);

                if (matches) {
                    this.ban_list.remove(matches[1]);
                }

                await sendTempMessage(
                    this.msg.chat?.id,
                    'done.',
                    5000,
                );

                return;
            }

            if (this.ban_list.is_banned(this.msg.from?.id) || this.ban_list.is_banned(this.msg.from?.username)) {
                return;
            }

            if (this.msg.text === '!gpt4') {
                this.chat_session.reset_session();

                this.chat_session.ctx.conversation.with_backend(null);

                if (!this.chat_session.ctx.telegraph_config) {
                    await this.setup_telegraph();
                }

                return;
            }

            if (this.msg.text === '!claude') {
                this.chat_session.reset_session();

                this.chat_session.ctx.conversation.with_backend('claude');

                if (!this.chat_session.ctx.telegraph_config) {
                    await this.setup_telegraph();
                }

                return;
            }

            if (this.msg.text === '!dev') {
                this.chat_session.reset_session();

                this.chat_session.ctx.mode = 'dev';

                sendTempMessage(
                    this.msg.chat.id,
                    'dev mode enabled.',
                    2000,
                );

                return;
            }

            if (this.msg.text === '!r') {
                this.chat_session.reset_session();

                this.chat_session.ctx.mode = null;

                sendTempMessage(
                    this.msg.chat.id,
                    'session reset.',
                    2000,
                );

                return;
            }

            if (this.msg.text === '!debug') {
                const dump = JSON.stringify(this.chat_session.serialize(), null, 4);

                const chunks = chunk_string(dump, 4000);

                for (const chunk of chunks) {
                    await chill_send_message(
                        this.msg.chat.id,
                        `<pre language="json">${chunk}</pre>`,
                        {
                            parse_mode: 'html',
                        },
                    );
                }

                return;
            }

            if (this.msg.text === '!wo') {
                this.chat_session.ctx.is_working = false;
                return;
            }

            if (this.chat_session.ctx.is_working) {
                return;
            }

            if (this.msg.text === '!help') {
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

                await chill_send_message(
                    this.msg.chat.id,
                    reply,
                );

                return;
            }

            if (this.msg.text === '!ctp') {
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
                    this.msg.chat.id,
                    reply,
                    10000,
                    {
                        parse_mode: 'html',
                    },
                );

                return;
            }

            if (this.msg.text === '!r') {
                reload_profiles();
                return;
            }

            if (this.msg.text === '!cs') {
                await this.init();
                this.chat_session.ctx.last_message = null;
                return;
            }

            let ctp_params = /^!ctp ([a-zA-Z1-9\-]{1,15})$/.exec(this.msg.text);

            if (ctp_params !== null) {
                try {
                    const profile = profiles.get(ctp_params?.[1]);

                    if (!profile) {
                        await sendTempMessage(
                            this.msg.chat.id,
                            'No such persona.',
                            3000,
                        );
                    }

                    await this.init(ctp_params?.[1]);

                    this.chat_session.ctx.last_message = null;

                    if (is_private_message) {
                        await sendTempMessage(
                            this.msg.chat.id,
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

            let ctpc_params = /^!ctpc "([^"]{1,50})" "([^"]{1,50})" (.*)$/ig.exec(this.msg.text);

            if (ctpc_params !== null && ctpc_params?.[1] && ctpc_params?.[2] && ctpc_params?.[3]) {
                try {
                    if (!ctpc_params?.[3].toLocaleLowerCase().includes(ctpc_params?.[1].toLocaleLowerCase())) {
                        await sendTempMessage(
                            this.msg.chat.id,
                            `I can't find your persona name in your persona description, that's probably dumb.`,
                            3000,
                            {
                                ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                            },
                        );
                    }

                    await this.init_custom(
                        ctpc_params?.[1],
                        ctpc_params?.[2],
                        ctpc_params?.[3],
                    );

                    this.chat_session.ctx.last_message = null;

                    await sendTempMessage(
                        this.msg.chat.id,
                        `Custom persona set! Name: ${ctpc_params?.[1]} Name (other): ${ctpc_params?.[2]}`,
                        3000,
                        {
                            ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                        },
                    );
                } catch (err) {
                    console.log(err);
                }

                return;
            }

            if (this.msg.text.indexOf('!ctpc') === 0) {
                await sendTempMessage(
                    this.msg.chat.id,
                    `Invalid command, missing a quote? Try \`!ctpc "Your name" "Their name" <persona description>\``,
                    3000,
                    {
                        ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                        parse_mode: 'MarkdownV2',
                    },
                );

                return;
            }

            let cp_params = /^!cp (.*)$/ig.exec(this.msg.text);

            if (cp_params !== null && cp_params?.[1]) {
                try {
                    await this.init_custom(
                        cp_params?.[1],
                        'User',
                        `You are ${cp_params?.[1]}.`,
                    );

                    this.chat_session.ctx.last_message = null;

                    await sendTempMessage(
                        this.msg.chat.id,
                        `Custom persona set! Name: ${cp_params?.[1]} Name (other): User`,
                        3000,
                        {
                            ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                        },
                    );
                } catch (err) {
                    console.log(err);
                }

                return;
            }

            if (this.msg.text.indexOf('!cp') === 0) {
                await sendTempMessage(
                    this.msg.chat.id,
                    `Invalid command? Try \`!cp Albert Einstein\``,
                    3000,
                    {
                        ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                        parse_mode: 'MarkdownV2',
                    },
                );

                return;
            }

            // if message starts with !cr, reinit the session using the profile "g"
            if (this.msg.text?.startsWith('!cr')) {
                await this.init(
                    this.get_chat_profile(),
                );

                this.chat_session.ctx.last_message = null;
            }

            const verbatim_response = /^!vr\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(this.msg.text);

            if (verbatim_response && (is_reply && verbatim_response[2])) {
                await this.do_msg_things(
                    `----Message:----${this.msg.reply_to_message?.text}----${verbatim_response[2]}----`,
                    true,
                    parseFloat(verbatim[1]) || 0.7,
                    '----',
                );

                return;
            }

            const verbatim = /^!v\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(this.msg.text);

            if (verbatim && verbatim[2]) {
                await this.do_msg_things(
                    `${verbatim[2]}----`,
                    true,
                    parseFloat(verbatim[1]) || 0.7,
                    '----',
                );

                return;
            }

            const verbatim_claude = /^!vc\s(\d+\.\d\d?)?\s?([\s\S]+)$/ig.exec(this.msg.text);

            if (verbatim_claude && verbatim_claude[2]) {
                this.chat_session.ctx.is_working = true;

                await bot.sendChatAction(this.msg.chat.id, 'typing');

                try {
                    const response = await fetch_absolutely_verbatim(
                        verbatim_claude[2],
                    );

                    await chill_send_message(
                        this.msg.chat.id,
                        response,
                        {
                            disable_web_page_preview: true,
                            disable_notification: true,
                            ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                        },
                    );
                } catch (err) {
                    console.log(err);

                    try {
                        await sendTempMessage(
                            this.msg.chat.id,
                            `Error: ${err.message}`,
                            3000,
                            {
                                ...(is_private_message ? {} : { reply_to_message_id: this.msg.message_id }),
                            },
                        );
                    } catch {}
                }

                this.chat_session.ctx.is_working = false;

                return;
            }

            const verbatim_stop = /^!vs\s(\d+\.\d\d?)\s(\S+)?\s([\s\S]+)$/ig.exec(this.msg.text);

            if (verbatim_stop && verbatim_stop[1] && verbatim_stop[2] && verbatim_stop[3]) {
                await this.do_msg_things(
                    verbatim_stop[3],
                    true,
                    0.7,
                    verbatim_stop[2],
                );

                return;
            }

            const explain = /^(!exp|!explain)(\s[\s\S]+)?$/ig.exec(this.msg.text);

            if (explain && is_reply) {
                await this.do_msg_things(
                    `----Message:----\n${is_reply ? this.msg?.reply_to_message?.text : explain[2]}\n----Explain ${is_reply ? (explain[2] || '') : ''}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            if (explain && (!is_reply && explain[2])) {
                await this.do_msg_things(
                    `Explain ${is_reply ? (explain[2] || '') : ''}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            const step_by_step = /^(!sbs|!stepbystep)(\s[\s\S]+)?$/ig.exec(this.msg.text);

            if (step_by_step && is_reply) {
                await this.do_msg_things(
                    `----Message:----\n${is_reply ? this.msg?.reply_to_message?.text : step_by_step[2]}\n----Outline the message step by step ${is_reply ? (step_by_step[2] ? `(${step_by_step[2]})` : '') : ''}:----\n1.`,
                    true,
                    0.7,
                    '----',
                    (chat, msg, opts) => chill_send_message(chat, `1. ${msg}`, opts),
                );

                return;
            }

            if (step_by_step && (!is_reply && step_by_step[2])) {
                await this.do_msg_things(
                    `Outline step by step in the form of a list: ${step_by_step[2]}----\n1.`,
                    true,
                    0.7,
                    '----',
                    (chat, msg, opts) => chill_send_message(chat, `1. ${msg}`, opts),
                );

                return;
            }

            const meaning = /^(!mean|!meaning)(\s[\s\S]+)?$/ig.exec(this.msg.text);

            if (meaning && is_reply) {
                await this.do_msg_things(
                    `----Message:----\n${is_reply ? this.msg?.reply_to_message?.text : meaning[2]}\n----Meaning of the message ${is_reply ? (meaning[2] ? `(${meaning[2]})` : '') : ''}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            if (meaning && (!is_reply && meaning[2])) {
                await this.do_msg_things(
                    `Explain the meaning of ${meaning[2]}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            const summarize = /^(!sum|!summarize)(\s[\s\S]+)?$/ig.exec(this.msg.text);

            if (summarize && is_reply) {
                await this.do_msg_things(
                    `----Message:----\n${is_reply ? this.msg?.reply_to_message?.text : summarize[2]}\n----Summarize the message ${is_reply ? (summarize[2] ? `(${summarize[2]})` : '') : ''}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            if (summarize && (!is_reply && summarize[2])) {
                await this.do_msg_things(
                    `Write a summary of: ${summarize[2]}----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            const expand = /^(!expand|!ela|!elaborate)(\s[\s\S]+)?$/ig.exec(this.msg.text);

            if (expand && is_reply) {
                await this.do_msg_things(
                    `----Message:----\n${is_reply ? this.msg?.reply_to_message?.text : expand[2]}\n----Elaborate further ${is_reply ? (expand[2] ? `on ${expand[2]}` : '') : ''}:----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            if (expand && (!is_reply && expand[2])) {
                await this.do_msg_things(
                    `Elaborate on: ${expand[2]}----\n`,
                    true,
                    0.7,
                    '----',
                );

                return;
            }

            const visualize = /^(!vis|!visualize)(\s[\s\S]+)?$/ig.exec(this.msg.text);

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
                                        /(\b\w\S*\b)(?=\s*->)/gu,
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
                await this.do_msg_things(
                    `----Text----\n${is_reply ? this.msg?.reply_to_message?.text : visualize[2]}\n----Visualise as a detailed and elaborate graphviz digraph code, do not use special characters and ensure to properly escape all node and label names ${is_reply ? (visualize[2] ? `(${visualize[2]})` : '') : ''}:----\ndigraph G {`,
                    true,
                    0.7,
                    '----',
                    render_graphviz,
                );

                return;
            }

            const joke = /^!joke\s?([\s\S]+)$/ig.exec(this.msg.text);

            if (joke) {
                if (joke[1]) {
                    await this.do_msg_things('Tell me a joke about ' + joke[1]);
                } else {
                    await this.do_msg_things('Tell me a joke');
                }

                return;
            }

            const cr = /^(!cr|!c)?\s?([\s\S]+)$/ig.exec(this.msg.text);

            if (cr && (cr[1] || is_private_message)) {
                if (
                    cr?.[1] === '!cr'
                    || (
                        this.chat_session.ctx.profile === null
                        && !this.chat_session.ctx.custom_profile
                        && this.chat_session.ctx.last_message === null
                    )
                ) {
                    await this.init(
                        this.get_chat_profile(),
                    );
                }

                await this.do_msg_things(cr[2]);

                return;
            }
        }

        static async from_message(msg, ban_list) {
            const chat_session = new ChatSession(
                msg.chat.id,
                msg.from?.id,
            );

            try {
                const session =
                    new ConversationFrame(
                        chat_session,
                        msg,
                        ban_list,
                    );

                await session.process();
            } catch(err) {
                console.log(err);
            }

            chat_session.persist();
        }
    }

    const ban_list = new BanList();

    bot.on('message', async msg => {
        try {
            await ConversationFrame.from_message(msg, ban_list);
        } catch (err) {
            console.log(err);
        }
    });

    bot.on('')
})();