
import sys

with open('server.mjs', 'r') as f:
    lines = f.readlines()

# 1. Update onboarding.chat attachments loop
# Search for "// 0. Handle Multimedia Silently (attachments)"
onboarding_start = -1
onboarding_end = -1
for i, line in enumerate(lines):
    if "// 0. Handle Multimedia Silently (attachments)" in line:
        onboarding_start = i
    if "const response = await groq.chat.completions.create({" in line and onboarding_start != -1:
        onboarding_end = i
        break

if onboarding_start != -1 and onboarding_end != -1:
    print(f"Updating onboarding.chat at lines {onboarding_start+1}-{onboarding_end}")
    new_onboarding = r"""            // 0. Handle Multimedia Silently (attachments)
            if (params.attachments && Array.isArray(params.attachments)) {
                for (const attachment of params.attachments) {
                    try {
                        let additionalContext = "";
                        if (attachment.type === 'audio' && attachment.data) {
                            const tempFile = `uploads/temp_audio_${Date.now()}`;
                            await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                            const text = await transcribeAudio(tempFile);
                            additionalContext = `[Audio Transcrito Silenciosamente: "${text}"]`;
                        } else if (attachment.type === 'image' && attachment.data) {
                            const tempFile = `uploads/temp_img_${Date.now()}`;
                            await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                            const description = await analyzeImage(tempFile);
                            await fs.unlink(tempFile).catch(() => {});
                            additionalContext = `[Imagen Analizada Silenciosamente: "${description}"]`;
                        } else if (attachment.text) {
                            additionalContext = `[Contexto Adicional: "${attachment.text}"]`;
                        }
                        
                        if (additionalContext) {
                            history.push({ role: 'system', content: additionalContext });
                        }
                    } catch (err) {
                        console.error("Error processing attachment:", err);
                    }
                }
            }

"""
    lines[onboarding_start:onboarding_end] = [new_onboarding]

# 2. Update /transcribe route
transcribe_start = -1
transcribe_end = -1
for i, line in enumerate(lines):
    if "app.post('/transcribe'" in line:
        transcribe_start = i
    if "res.json({ text: transcription.text });" in line and transcribe_start != -1:
        transcribe_end = i + 1 # include the end line
        break

if transcribe_start != -1 and transcribe_end != -1:
    print(f"Updating /transcribe at lines {transcribe_start+1}-{transcribe_end}")
    new_transcribe = r"""app.post('/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No audio file provided');
        const text = await transcribeAudio(req.file.path);
        res.json({ text });
    } catch (err) {
        console.error('[Transcription] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
"""
    lines[transcribe_start:transcribe_end] = [new_transcribe]

with open('server.mjs', 'w') as f:
    f.writelines(lines)
print("Success!")
