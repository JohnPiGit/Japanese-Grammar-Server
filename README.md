# Japanese-Grammar-Server
Front-end logic allowing you to use LLMs to grade pre-generated practice questions or answer questions related to the grammar topic. Can use API key or click button to copy a thing to paste into a chat-bot


## Running Locally (mostly for debugging)
- In the project root (`.../Japanese-Grammar-Server/`)
- in a python env (TODO: python env link here)
- `pip install requirements.txt` (or `uv pip install requirements.txt`, since uv 最高！)
- build with `python3 build.py`
- host/run local server with `python -m http.server 8000 -d dist`
- reach at http://0.0.0.0:8000/

## Known issues and Work-Arounds
- For a locally hosted endpoint (e.g. __Ollama__, __LM Studio__, __llama.cpp__), you'll need to enable CORS (Cross Origins something something) access (details not further elaborated - as in, look it up)
  - This fix will only allow you to use your local LLM endpoint on a locally hosted web-server, and another step needs to be made to make it work on the `github.io` hosted page, and that is to expose your local LLM endpoint over https (maybe that can be a security concern??? I haven't yet investigated... do your research)