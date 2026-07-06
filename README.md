# Repo Copy & Deploy

Copy a GitHub repository to another account and automatically deploy it to Vercel.

## Features

- Copy any public GitHub repository to a target account
- Organize copies in email-named folders
- Automatic Vercel deployment
- Clean, modern UI

## Prerequisites

- Node.js 18+
- GitHub Personal Access Token with `repo` scope
- Vercel API Token

## Local Development Setup

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd <repo-name>
npm install
```

### 2. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Navigate to Settings > API and copy your:
   - Project URL (`VITE_SUPABASE_URL`)
   - Anon/Public key (`VITE_SUPABASE_ANON_KEY`)

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 4. Deploy the Edge Function

The edge function handles GitHub API calls and Vercel deployment. Set these secrets in your Supabase dashboard:

1. Go to your Supabase project
2. Navigate to Edge Functions > repo-copier > Settings > Environment Variables
3. Add:
   - `GITHUB_TOKEN` - Your GitHub Personal Access Token (needs `repo` scope)
   - `VERCEL_TOKEN` - Your Vercel API token

Then deploy the function:

```bash
npx supabase functions deploy repo-copier
```

Or use the Supabase MCP tool if available.

### 5. Configure Vercel

Before the deployment feature works:

1. Go to [Vercel Account Settings](https://vercel.com/account/login-connections)
2. Connect your GitHub account
3. Grant access to the organizations you want to deploy to

### 6. Run Development Server

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

## Usage

1. Enter the source GitHub repository URL
2. Enter the target repository URL (format: `https://github.com/owner/repo-name`)
3. Enter your email address - files will be copied to a folder named after your email
4. Click "Submit" to copy and deploy

The source repository will be copied into a folder named after your email in the target repository, and Vercel will automatically deploy it.

## Build for Production

```bash
npm run build
```

The built files will be in the `dist/` directory.

## API Tokens Needed

### GitHub Personal Access Token

1. Go to https://github.com/settings/tokens
2. Generate new token (classic)
3. Select `repo` scope (full control of private/public repositories)
4. Copy the token

### Vercel API Token

1. Go to https://vercel.com/account/tokens
2. Create a new token
3. Copy the token

## Tech Stack

- React 18 + TypeScript
- Vite
- Tailwind CSS
- Lucide React Icons
- Supabase Edge Functions (Deno runtime)
- GitHub REST API
- Vercel REST API

## Project Structure

```
├── src/
│   ├── App.tsx          # Main UI component
│   ├── main.tsx         # React entry point
│   └── index.css        # Tailwind styles
├── supabase/
│   └── functions/
│       └── repo-copier/
│           └── index.ts # Edge function for GitHub/Vercel APIs
├── .env                 # Environment variables (local)
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## License

MIT
