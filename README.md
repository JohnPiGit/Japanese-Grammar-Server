# Japanese-Grammar-Server
Fully client-side website allowing you to use LLMs to grade pre-generated practice questions or answer questions related to the grammar topic. You can provide an API key for one of the main AI providers (`OpenAI`, `Gemini`, or `Anthropic`) or use a custom endpoint (`OpenAI compatible`) to stream the LLM's response directly on the webpage. If you don't, then pressing the submit button for any time you would usually make an LLM call, will instead format the prompt's sent to the LLM into 1 prompt, and copy it to your clipboard for you to paste into any __Free__ AI service of your choice (and can ask follow-up questions as you like)!

This is a prettied up version of a local webserver that I made and have been using for the last ~5 months to study Japanese grammar. I found my local/private version to be extremely helpful in learning and understanding Japanese grammar, so I figured it would be worth it to spiff it up and make it public (and hopefully someone else can find value in it).

I __HIGHLY__ recommend using yomitan (https://yomitan.wiki/) - a pop-up dictionary browser extension - with this (or even just using yomitan at all!) as it make looking up words soo easy that it's not even a burden.

All the lessons were generated using `Claude Sonnet 5.5` "grounded with google" from a list of hand-picked by me "grammar" topics (or really just things I wanted to study/practice) into a bunch of jsons that I format into "Lessons"

## Lesson Structure

Each lesson is about a "single" topic (that I at some point wanted to learn about) and is broken up into 4 sections:
- Explanation of the grammar topic
- 10 Example Japanese sentences with English translations
- 15 Translation Practice sentences with 2-3 reference answers (and LLM grading)
- 15 Response Practice sentences (designed to elicit a response in Japanese) with 2-3 reference answers (and LLM grading)

## Quality of AI Lessons and AI Grading

For the most part, I'm quite pleased with the quality of the explanation of each grammar topic, though there are certainly a few that are sub-par.

For the practice sentences (wether it be the Examples, translation practice, or response practice), it is pretty hit or miss. However, my general experience/impression has been that the mere process of practicing outputting Japanese (speaking/writing/typing) has significantly increased my ability to output (quite the revelation) and therefore - even though some of the sentences are quite bad - I've found it much more useful than nothing. (though the difficulty level is not at all consistent)

For the grading, this is where I've found the most value, because it gives immediate feedback on my mistakes, and more importantly allows me to ask follow-up questions for clarification or digging deeper into a concept (or for calling bs on it's response until one of us realizes the other is correct...). Of course, depending on the model you use it can be more or less wrong and you may need to independently verify it's feedback more or less (I occasionally feel doubtful of `gemma-4-26b-a4b-it` and have to do some googling).

# Webpage Layout/Details

## Config
At the top of every page is a config section for setting up your Provider, API-key and model. There is also a furigana (a.k.a Ruby) toggle button that will put the hiragana readings above all the kanji (though it's automatically generated using `pykakasi` and is incorrect more often then I would like, so again, USE [yomitan](https://yomitan.wiki/)!)

## Home Page
Simple list of links to all the grammar topics, along with the number of completed `translation practice sentences` and number of completed `response practice sentences`. Clicking on any of the completion totals will:
- Clear all of your progress for that section (if `num_completed > 0`)
- Set all of the sentences for that section to answered (if `num_completed == 0`)

## Lesson
Explanation of the grammar topic. There is a submission box where you can ask the LLM (or have a prompt copied to you clipboard) any question about the grammar topic

## 10 Example sentences
Each is a Japanese sentence that uses the grammar topic in some way. Clicking on the `Translation` dropdown will show:
- The translation
- An explanation of how the grammar topic was used in this sentence
- Another submission box for you to query the LLM. It uses the explanation of the grammar topic, and the sentence and translation as context for your question

## 15 Translation Practice Sentences
Each is a sentence in English (whos reference answers use the grammar topic) that you can translate and submit for it to be LLM-graded. The prompt for the LLM grader:
- Intentionally does __NOT__ get the context of the grammar lesson. I didn't (and still don't) want the grader to potentially be poisoned or biased by the AI-generated Lesson
- Has the reference answers as context, but is explicitly told that they have not been verified and to not take them at face value

This allows for you to translate the sentence how ever you see fit and be graded on the correctness of your Japanese, rather than being tied down to a very specific interpretation and grammar choice. (Plenty of times have I thought that I could translate a sentence in a "unique" way or test out some other grammar, and been able to creatively express myself whilst getting valuable feedback)

The LLM that generated the practice sentences was prompted to make them increase in difficulty from easy to medium (plateauing after 10 sentences), but sometimes the later sentences can get a little ridiculous in difficulty (e.g. 1. `There is no way that is true.` -> 15. `Considering the strict security measures at the research facility, there is no way confidential data was leaked from the inside.`)

The grade the LLM gives you is kind of meaningless if you don't get an __A__ (It gave me a __D__ for translating "this is a pen" as "こりゃペンだぜ！"), but the feedback you get when you get it wrong is extremely valuable.

## 15 Response Practice Sentences
Each is a sentence in __Japanese__, designed to elicit a response that could conceivably use the grammar topic. There's also context in __English__ that is under a drop-down (The context can often do a lot of the translation for you or heavily bias your response, so I mostly treat is as a hint)

The LLM grader prompt for this is pretty similar to the `Translation Practice`, but it also adds the context (but is again only told to treat it as a suggestion, rather than stifling your creative freedom)

# Safety and Security Considerations
The main thing that could be of concern is "how is my API key handled?" It is simply stored in memory, which gets cleared away any time you refresh your browser or exit this page. It doesn't get stored locally, and it isn't sent anywhere other than the AI provider you have selected (selecting a different AI provider will clear your api key so that you can't accidentally sent it to the wrong place).

In general, no information gets sent anywhere except the AI provider you have selected (and all they receive it your API key and bare-minimum prompts for answering the questions you asked). The Github server you reach out to when putting https://johnpigit.github.io/Japanese-Grammar-Server into the url is the html, java script, css, prompts, and lessons.json. No other http requests are made to Github beyond those initial ones, as the website utilizes hash-routing to keep everything in 1 browser session (that way you don't have to re-enter your api key for every new lesson page you click on)

The form box you put your API key in is treated like a password field, and the AIProvider selected is treated like a username, so you can have google save your API key for you and have it saved by provider. (google's password saver is of course going to be way more secure than anything I can cobble together, and it's easier to use)

## Running Locally (mostly for debugging)
- clone with `git clone https://github.com/JohnPiGit/Japanese-Grammar-Server.git`
- In the project root (`.../Japanese-Grammar-Server/`)
- in a python env `python3 -m venv .my_venv`
- `pip install requirements.txt` (or `uv pip install requirements.txt`, since uv 最高！)
- build with `python3 build.py`
- host/run local server with `python -m http.server 8000 -d dist`
- reach at http://0.0.0.0:8000/
- Any subsequent uses of this, you don't need to re-install anything, just re-activate your python environment with `source my_venv/bin/activate`

## Known issues and Work-Arounds
- For a locally hosted endpoint (e.g. __Ollama__, __LM Studio__, __llama.cpp__), you'll need to enable CORS (Cross Origins something something) access (details not further elaborated - as in, look it up)