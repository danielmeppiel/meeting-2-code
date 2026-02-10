---
name: copilot-sdk-setup
description: Interactive skill that guides users through setting up the GitHub Copilot SDK in new or existing projects. Supports TypeScript, Python, Go, and .NET.
license: MIT
compatibility: Requires Copilot CLI installed. Supports Node.js 18+, Python 3.8+, Go 1.21+, or .NET 8.0+.
metadata:
  author: github
  version: "1.0"
allowed-tools: npm npx pip go dotnet git uv
---

# Copilot SDK Setup

An interactive skill that walks users through integrating the GitHub Copilot SDK into their projects. It handles both new project creation and modification of existing projects.

## When to Use

- User wants to add the Copilot SDK to a project
- User says "set up copilot sdk" or "add copilot to my project"
- User wants to create an AI-powered application
- User asks about integrating Copilot programmatically
- User wants to build agents or tools using the Copilot SDK

## Instructions

### Step 1: Determine Project Type (REQUIRED FIRST STEP)

**Ask the user:**
```
Are you creating a new project or modifying an existing one?
1. New project - I want to create a fresh project with the Copilot SDK
2. Existing project - I want to add the Copilot SDK to my current codebase
```

**Do not proceed until the user answers.**

---

### Step 2A: New Project Flow

If the user selected "New project":

#### 2A.1: Ask for Language

```
Which language would you like to use?
1. TypeScript (Node.js) - npm install @github/copilot-sdk
2. Python - pip install github-copilot-sdk
3. Go - go get github.com/github/copilot-sdk/go
4. .NET (C#) - dotnet add package GitHub.Copilot.SDK
```

#### 2A.2: Ask What They Want to Build

```
What would you like to build with the Copilot SDK?
Examples:
- A CLI assistant that answers questions
- A chatbot with custom tools
- An automated code reviewer
- A document analyzer
- A custom agent for specific tasks

Please describe your use case:
```

#### 2A.3: Ask for Project Name

```
What would you like to name this project? (use kebab-case, e.g., my-copilot-app)
```

Validate the name:
- Only lowercase letters, numbers, and hyphens
- No spaces or special characters
- Not starting/ending with hyphen

#### 2A.4: Initialize Project Based on Language

**TypeScript:**
```bash
mkdir <project-name> && cd <project-name>
npm init -y
npm pkg set type="module"
npm install @github/copilot-sdk tsx typescript @types/node
npx tsc --init --module NodeNext --moduleResolution NodeNext --target ES2022 --outDir dist --rootDir src
mkdir -p src
```

**Python:**
```bash
mkdir <project-name> && cd <project-name>
uv init --name <project-name>
uv add github-copilot-sdk
mkdir -p src/<project_name>
touch src/<project_name>/__init__.py
```

Or without uv:
```bash
mkdir <project-name> && cd <project-name>
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install github-copilot-sdk
mkdir -p src
```

**Go:**
```bash
mkdir <project-name> && cd <project-name>
go mod init <project-name>
go get github.com/github/copilot-sdk/go
```

**.NET:**
```bash
dotnet new console -n <ProjectName> && cd <ProjectName>
dotnet add package GitHub.Copilot.SDK
```

---

### Step 2B: Existing Project Flow

If the user selected "Existing project":

#### 2B.1: Detect Project Language(s)

Examine the current directory for project files:

```bash
# Check for project markers
ls -la
```

**Detection rules:**
- `package.json` → TypeScript/JavaScript
- `pyproject.toml`, `setup.py`, `requirements.txt` → Python
- `go.mod` → Go
- `*.csproj`, `*.sln` → .NET
- `Cargo.toml` → Rust (not yet supported, inform user)

#### 2B.2: Handle Multiple Languages

If multiple project types detected:
```
I detected multiple project types in this directory:
- package.json (TypeScript/JavaScript)
- pyproject.toml (Python)

Which language would you like to add the Copilot SDK to?
1. TypeScript/JavaScript
2. Python
```

#### 2B.3: Ask About Use Case

```
What would you like to use the Copilot SDK for in this project?
Examples:
- Add an AI assistant feature
- Implement automated code analysis
- Create custom tools that Copilot can call
- Build an agent for a specific workflow

Please describe your use case:
```

#### 2B.4: Install SDK for Detected Language

**TypeScript/JavaScript:**
```bash
npm install @github/copilot-sdk
# If TypeScript project, also:
npm install -D tsx typescript @types/node
```

**Python:**
```bash
# With uv:
uv add github-copilot-sdk

# With pip:
pip install github-copilot-sdk
# Add to requirements.txt if it exists:
echo "github-copilot-sdk" >> requirements.txt
```

**Go:**
```bash
go get github.com/github/copilot-sdk/go
```

**.NET:**
```bash
dotnet add package GitHub.Copilot.SDK
```

---

### Step 3: Create Starter Code

Based on the user's language and use case, create appropriate starter code.

#### TypeScript Starter (`src/index.ts`):

```typescript
import { CopilotClient, defineTool } from "@github/copilot-sdk";

// Example custom tool - modify based on user's use case
const exampleTool = defineTool("example_tool", {
    description: "Description of what this tool does",
    parameters: {
        type: "object",
        properties: {
            input: { type: "string", description: "Input parameter" },
        },
        required: ["input"],
    },
    handler: async (args: { input: string }) => {
        // Implement tool logic here
        return { result: `Processed: ${args.input}` };
    },
});

async function main() {
    const client = new CopilotClient();
    const session = await client.createSession({
        model: "gpt-4.1",
        streaming: true,
        tools: [exampleTool],
    });

    // Listen for response chunks
    session.on("assistant.message_delta", (event) => {
        process.stdout.write(event.data.deltaContent);
    });
    session.on("session.idle", () => {
        console.log();
    });

    // Send a message
    await session.sendAndWait({ prompt: "Hello! What can you help me with?" });

    await client.stop();
    process.exit(0);
}

main().catch(console.error);
```

#### Python Starter (`src/main.py`):

```python
import asyncio
import sys
from copilot import CopilotClient
from copilot.tools import define_tool
from copilot.generated.session_events import SessionEventType
from pydantic import BaseModel, Field


class ExampleParams(BaseModel):
    """Parameters for the example tool."""
    input: str = Field(description="Input parameter")


@define_tool(description="Description of what this tool does")
async def example_tool(params: ExampleParams) -> dict:
    """Implement tool logic here."""
    return {"result": f"Processed: {params.input}"}


async def main():
    client = CopilotClient()
    await client.start()

    session = await client.create_session({
        "model": "gpt-4.1",
        "streaming": True,
        "tools": [example_tool],
    })

    def handle_event(event):
        if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
            sys.stdout.write(event.data.delta_content)
            sys.stdout.flush()
        if event.type == SessionEventType.SESSION_IDLE:
            print()

    session.on(handle_event)

    await session.send_and_wait({"prompt": "Hello! What can you help me with?"})

    await client.stop()


if __name__ == "__main__":
    asyncio.run(main())
```

#### Go Starter (`main.go`):

```go
package main

import (
	"fmt"
	"log"
	"os"

	copilot "github.com/github/copilot-sdk/go"
)

// ExampleParams defines parameters for the example tool
type ExampleParams struct {
	Input string `json:"input" jsonschema:"Input parameter"`
}

// ExampleResult defines the result structure
type ExampleResult struct {
	Result string `json:"result"`
}

func main() {
	// Define a custom tool
	exampleTool := copilot.DefineTool(
		"example_tool",
		"Description of what this tool does",
		func(params ExampleParams, inv copilot.ToolInvocation) (ExampleResult, error) {
			// Implement tool logic here
			return ExampleResult{Result: fmt.Sprintf("Processed: %s", params.Input)}, nil
		},
	)

	client := copilot.NewClient(nil)
	if err := client.Start(); err != nil {
		log.Fatal(err)
	}
	defer client.Stop()

	session, err := client.CreateSession(&copilot.SessionConfig{
		Model:     "gpt-4.1",
		Streaming: true,
		Tools:     []copilot.Tool{exampleTool},
	})
	if err != nil {
		log.Fatal(err)
	}

	// Listen for response chunks
	session.On(func(event copilot.SessionEvent) {
		if event.Type == "assistant.message_delta" {
			fmt.Print(*event.Data.DeltaContent)
		}
		if event.Type == "session.idle" {
			fmt.Println()
		}
	})

	_, err = session.SendAndWait(copilot.MessageOptions{
		Prompt: "Hello! What can you help me with?",
	}, 0)
	if err != nil {
		log.Fatal(err)
	}
	os.Exit(0)
}
```

#### .NET Starter (`Program.cs`):

```csharp
using GitHub.Copilot.SDK;
using Microsoft.Extensions.AI;
using System.ComponentModel;

// Define a custom tool
var exampleTool = AIFunctionFactory.Create(
    ([Description("Input parameter")] string input) =>
    {
        // Implement tool logic here
        return new { result = $"Processed: {input}" };
    },
    "example_tool",
    "Description of what this tool does"
);

await using var client = new CopilotClient();
await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-4.1",
    Streaming = true,
    Tools = [exampleTool],
});

// Listen for response chunks
session.On(ev =>
{
    if (ev is AssistantMessageDeltaEvent deltaEvent)
    {
        Console.Write(deltaEvent.Data.DeltaContent);
    }
    if (ev is SessionIdleEvent)
    {
        Console.WriteLine();
    }
});

await session.SendAndWaitAsync(new MessageOptions
{
    Prompt = "Hello! What can you help me with?",
});
```

---

### Step 4: Customize Based on Use Case

Modify the starter code based on the user's described use case:

**For CLI assistants:**
- Add readline/input handling for interactive mode
- Implement conversation history

**For chatbots with custom tools:**
- Define tools specific to the user's domain
- Add appropriate parameter schemas

**For code reviewers:**
- Add file reading tools
- Implement diff analysis
- Connect to Git operations

**For document analyzers:**
- Add file/document reading capabilities
- Implement parsing tools for specific formats

---

### Step 5: Add Run Scripts

**TypeScript (package.json):**
```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "build": "tsc",
    "dev": "tsx watch src/index.ts"
  }
}
```

**Python (pyproject.toml):**
```toml
[project.scripts]
app = "src.main:main"
```

**Go:** Already runnable with `go run main.go`

**.NET:** Already runnable with `dotnet run`

---

### Step 6: Verify Setup

Run a test to ensure everything works:

**TypeScript:**
```bash
npm start
# or
npx tsx src/index.ts
```

**Python:**
```bash
python src/main.py
# or with uv:
uv run python src/main.py
```

**Go:**
```bash
go run main.go
```

**.NET:**
```bash
dotnet run
```

---

### Step 7: Summary

Report to the user:

```
✅ Copilot SDK setup complete!

📦 Installed:
- GitHub Copilot SDK for <language>
- Starter code with example tool

🚀 Quick start:
  <run command>

📚 Next steps:
1. Modify the example tool to match your use case
2. Add more tools as needed
3. Customize the system message and model
4. Check the SDK documentation: https://github.com/github/copilot-sdk

💡 Key concepts:
- Tools let Copilot call your code
- Streaming shows responses in real-time
- Sessions maintain conversation context
- Custom agents can have specialized behavior
```

## Output Format

Always provide:
1. **Confirmation of choices** made by the user
2. **Commands executed** with their output
3. **Files created** with brief descriptions
4. **Run instructions** for testing
5. **Next steps** for customization

## SDK Quick Reference

### Installation Commands

| Language    | Command                                    |
|-------------|-------------------------------------------|
| TypeScript  | `npm install @github/copilot-sdk`         |
| Python      | `pip install github-copilot-sdk`          |
| Go          | `go get github.com/github/copilot-sdk/go` |
| .NET        | `dotnet add package GitHub.Copilot.SDK`   |

### Key Features

- **Custom Tools**: Define functions that Copilot can call
- **Streaming**: Real-time response output
- **Sessions**: Maintain conversation context
- **MCP Servers**: Connect to external tool providers
- **Custom Agents**: Create specialized AI personas

### Resources

- [GitHub Copilot SDK Repository](https://github.com/github/copilot-sdk)
- [Getting Started Guide](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md)
- [Cookbook Examples](https://github.com/github/copilot-sdk/tree/main/cookbook)
- [MCP Documentation](https://github.com/github/copilot-sdk/blob/main/docs/mcp.md)

## Reference Documentation

When you need more details about SDK usage, fetch documentation from the `github/copilot-sdk` repository:

### Core Documentation Files

| Document | Path | Description |
|----------|------|-------------|
| Getting Started | `docs/getting-started.md` | Full tutorial with streaming, tools, and interactive examples |
| MCP Servers | `docs/mcp.md` | Connecting to Model Context Protocol servers |

### Language-Specific READMEs

| Language | Path | Description |
|----------|------|-------------|
| Node.js/TypeScript | `nodejs/README.md` | TypeScript SDK API reference and examples |
| Python | `python/README.md` | Python SDK API reference and examples |
| Go | `go/README.md` | Go SDK API reference and examples |
| .NET | `dotnet/README.md` | .NET SDK API reference and examples |

### Cookbook Recipes (by language)

Each language has practical recipes in `cookbook/<language>/`:

- `error-handling.md` - Handle connection failures, timeouts, cleanup
- `multiple-sessions.md` - Manage multiple conversations simultaneously
- `managing-local-files.md` - Organize files using AI-powered grouping
- `pr-visualization.md` - Generate PR charts using GitHub MCP Server
- `persisting-sessions.md` - Save and resume sessions across restarts

### How to Fetch Documentation

Use the GitHub MCP tools or `gh` CLI to fetch the latest docs:

```bash
# Fetch getting started guide
gh api repos/github/copilot-sdk/contents/docs/getting-started.md -H "Accept: application/vnd.github.raw"

# Fetch language-specific README
gh api repos/github/copilot-sdk/contents/nodejs/README.md -H "Accept: application/vnd.github.raw"

# Fetch a cookbook recipe
gh api repos/github/copilot-sdk/contents/cookbook/nodejs/error-handling.md -H "Accept: application/vnd.github.raw"
```

Or use the `github-mcp-server-get_file_contents` tool:
- owner: `github`
- repo: `copilot-sdk`
- path: `docs/getting-started.md` (or other paths above)

## Error Handling

### Common Issues

**"copilot command not found":**
```
The Copilot CLI is required. Please install it first:
https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli
```

**Authentication errors:**
```
Please authenticate with the Copilot CLI:
copilot auth login
```

**Package installation failures:**
```
For TypeScript: Ensure Node.js 18+ is installed
For Python: Ensure Python 3.8+ is installed
For Go: Ensure Go 1.21+ is installed
For .NET: Ensure .NET 8.0+ SDK is installed
```

## Constraints

- Always verify the Copilot CLI is installed before proceeding
- Use the latest stable SDK versions
- Create minimal, focused starter code
- Let users customize based on their needs
- Do not include secrets or API keys in generated code