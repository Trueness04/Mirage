const HUMAN_PROMPTS = [
  'Hi, how are you?',
  'Could you give a brief explanation of artificial intelligence?',
  'What is the weather like today?',
  'Tell me a short story',
  'Do you think it will rain tomorrow?',
  'Tell me a joke',
  'What is the capital of France?',
  'Can you help me with a simple math problem?',
  'What is the best way to learn programming?',
  'What is your favorite color?',
]

export class ModelHealth {
  private lastPassive = 0

  recordPassiveSuccess() {
    this.lastPassive = Date.now()
  }

  // Only probe if there hasn't been a real request recently
  shouldProbe(now = Date.now()): boolean {
    return now - this.lastPassive > 60 * 60_000 // 1h idle
  }

  // Rotate prompt
  pickPrompt(): string {
    return HUMAN_PROMPTS[Math.floor(Math.random() * HUMAN_PROMPTS.length)]
  }
}
