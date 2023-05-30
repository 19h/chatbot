# AI Telegram Chatbot

This program is an AI-powered Telegram chatbot that utilizes various AI models to have conversations, answer questions, and generate responses. Some of the key features of this chatbot are:

- Handles private chats and group chats with Telegram users.
- Allows users to set a persona/profile for the bot, which changes its responses.
- Includes commands for generating custom responses, summarizing messages, outlining messages step-by-step, explaining meaning/significance, elaborating on messages, visualizing messages as graphs, telling jokes, and more.
- Persists user sessions and profiles to disk so conversations can continue across restarts.
- Uses AI models like GPT-4 (via EvilCorp SecondPilot) and Claude for message generation.
- Can visualize graphviz code via the `!vis` command (as reply, and verbatim).
- Handles errors and messages that are too long for Telegram.
- Includes admin commands for banning users and debugging the bot.

## Getting Started

To get started with this program, you will need to add the relevant tokens to the `.env` file. The required tokens are:

- TELEGRAM_TOKEN
- GITHUB_PAT_TOKEN
- CLAUDE_API_TOKEN

Once you have added the tokens to the `.env` file, you can run the program by executing the `run.sh` script.

## Usage

To use the chatbot, simply start a chat with the bot in Telegram. You can then use any of the available commands to interact with the chatbot and generate responses.

## Contributing

If you would like to contribute to this project, please fork the repository and submit a pull request. We welcome contributions of all kinds, including bug fixes, new features, and documentation improvements.

## License

This program is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.