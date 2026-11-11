# Privacy-Aware RAG Bot (Auth0 FGA)

HR knowledge assistant. Every retrieved document is checked with **FGA** (`check` per user/document) *before* it is passed to the LLM, so confidential documents never reach the model for users who may not read them.

- Model: `department#member`, `department#manager`; `document#viewer` = department members, `document#confidential_viewer` = department managers.
- Alice (HR manager) gets the salary bands; Bob (employee) is DENIED `salary_bands_2027` and `budget_Q4` even though the retriever found them.
- Runs against a local OpenFGA server (`docker run -p 8080:8080 openfga/openfga run`), the engine behind Auth0 FGA. Point `FGA_API_URL`/store/credentials at Auth0 FGA to use the hosted service.
- LLM: Groq `openai/gpt-oss-120b` (`GROQ_API_KEY` in `.env`), answers only from authorized context.

`npm install && node rag-bot.js` → see `rag-bot-output.txt` (self-checks pass).
