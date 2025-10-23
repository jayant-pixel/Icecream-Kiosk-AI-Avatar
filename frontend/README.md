# LiveKit Meet with AI Agents
A video meeting web app that can request AI agents to join. Setup for voice agents that you can give a profile image or an avatar agent that will display the avatar's video.

Demo Video: [LiveKit Meet Agents Demo Video](https://youtu.be/HoKk1KlDwq0?si=zGPH1_tl9KPbjAWI)

## Getting Started

Copy .env.example file and create new file .env or .env.local.
Now fill in the environment variables there with your own data.

First, run frontend:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Second, run backend agent:

In the agents directory, copy .env.example file and create new file .env or .env.local.
Now fill in the environment variables there with your own data.

Basic voice agent and avatar agent is provided in the agents directory to run separately.
See agents directory README.md to get started and run agent of choice.
