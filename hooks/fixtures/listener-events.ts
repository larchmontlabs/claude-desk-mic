// Mirror of listener-events.jsonl for the mod tests, which cannot read files.
// engine/tests/test_contract.py fails if this text and the .jsonl differ.
// Edit the .jsonl, then paste its lines between the backticks.
export const LISTENER_EVENTS_JSONL = `
{"type":"ready","device":"Desk Microphone","mute_key":"Right Option","pid":4242}
{"type":"loading","model":"base.en"}
{"type":"utterance","text":"run the tests"}
{"type":"state","listening":false,"source":"voice command"}
{"type":"speaking","playing":true}
{"type":"takeover","previous_pid":4141}
{"type":"error","stage":"device","message":"No microphone found."}
{"type":"error","stage":"mic","message":"Could not open the microphone."}
{"type":"error","stage":"model","message":"Could not load the Whisper model base.en."}
{"type":"error","stage":"deepgram","message":"Could not connect to Deepgram."}
{"type":"error","stage":"mute_key","message":"mute key unavailable"}
{"type":"error","stage":"connection","message":"Deepgram connection closed: x"}
{"type":"error","stage":"takeover","message":"Another desk-mic listener (pid 4141) would not stop."}
`
