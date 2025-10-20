hey the present llm is not directly linked to the heygen it was using the assistant id in the info i gave creation and using of assitant happens in one code see and implement you have idea and context on my whole project refactor the heygen avatar to connect with llm response the flow look like the stt trnacibe and send that to llm and it takes and gives back response and the response is spoken by heygen in ui also thier is not stop listenting it will wait until user stops i need an stop listening button and when listencing stops the stt send audio trancsiption starts ...etc i need you to remove any unwanted code and reafactor to work like this be caution by making changes don;t make changes that makes errors do websearch if you want any info we accurate and error free remove the text sending option in ui only mic,
and also the creation is directly being done and getting making run this code is just for demo modify for production and update the existing remove, add do what every you wnat but make the llm connected to heygen and tool calling to llm via webhooks for product feathcing ..ect thinsg i will provide them lates but add .

docs info for context:
Step 2: Createopenai-assistant.ts
This file contains a class to interact with OpenAI's API. Place it in the src folder.

openai-assistant.ts

import OpenAI from "openai";

export class OpenAIAssistant {
  private client: OpenAI;
  private assistant: any;
  private thread: any;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
  }

  async initialize(
    instructions: string = `You are an English tutor. Help students improve their language skills by:
    - Correcting mistakes in grammar and vocabulary
    - Explaining concepts with examples
    - Engaging in conversation practice
    - Providing learning suggestions
    Be friendly, adapt to student's level, and always give concise answers.`
  ) {
    // Create an assistant
    this.assistant = await this.client.beta.assistants.create({
      name: "English Tutor Assistant",
      instructions,
      tools: [],
      model: "gpt-4-turbo-preview",
    });

    // Create a thread
    this.thread = await this.client.beta.threads.create();
  }

  async getResponse(userMessage: string): Promise<string> {
    if (!this.assistant || !this.thread) {
      throw new Error("Assistant not initialized. Call initialize() first.");
    }

    // Add user message to thread
    await this.client.beta.threads.messages.create(this.thread.id, {
      role: "user",
      content: userMessage,
    });

    // Create and run the assistant
    const run = await this.client.beta.threads.runs.createAndPoll(
      this.thread.id,
      { assistant_id: this.assistant.id }
    );

    if (run.status === "completed") {
      // Get the assistant's response
      const messages = await this.client.beta.threads.messages.list(
        this.thread.id
      );

      // Get the latest assistant message
      const lastMessage = messages.data.filter(
        (msg) => msg.role === "assistant"
      )[0];

      if (lastMessage && lastMessage.content[0].type === "text") {
        return lastMessage.content[0].text.value;
      }
    }

    return "Sorry, I couldn't process your request.";
  }
}
Using dangerouslyAllowBrowser: true allows direct API calls from the browser.

Best Practice: For security, perform these calls on your backend instead of exposing the API key in the browser. This implementation is kept simple for demonstration.

Step 3: Updatemain.ts
Import and Declare the Assistant:
main.ts


import { OpenAIAssistant } from "./openai-assistant";

let openaiAssistant: OpenAIAssistant | null = null;
UpdateinitializeAvatarSession :
Add the OpenAI assistant initialization:

main.ts

// Initialize streaming avatar session
async function initializeAvatarSession() {
  // Disable start button immediately to prevent double clicks
  startButton.disabled = true;

  try {
    const token = await fetchAccessToken();
    avatar = new StreamingAvatar({ token });

    // Initialize OpenAI Assistant
    const openaiApiKey = import.meta.env.VITE_OPENAI_API_KEY;
    openaiAssistant = new OpenAIAssistant(openaiApiKey);
    await openaiAssistant.initialize();
    
    avatar.on(StreamingEvents.STREAM_READY, handleStreamReady);
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, handleStreamDisconnected);
    
    sessionData = await avatar.createStartAvatar({
      quality: AvatarQuality.Medium,
      avatarName: "Wayne_20240711",
      language: "English",
    });

    console.log("Session data:", sessionData);

    // Enable end button
    endButton.disabled = false;

  } catch (error) {
    console.error("Failed to initialize avatar session:", error);
    // Re-enable start button if initialization fails
    startButton.disabled = false;
  }
}
UpdatehandleSpeak :
Passes user input to OpenAI, retrieves a response, and instructs the avatar to speak the response aloud.

main.ts

// Handle speaking event
async function handleSpeak() {
  if (avatar && openaiAssistant && userInput.value) {
    try {
      const response = await openaiAssistant.getResponse(userInput.value);
      await avatar.speak({
        text: response,
        taskType: TaskType.REPEAT,
      });
    } catch (error) {
      console.error("Error getting response:", error);
    }
    userInput.value = ""; // Clear input after speaking
  }
}