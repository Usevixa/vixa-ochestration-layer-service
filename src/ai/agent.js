import { openai } from "./openai.js";

export async function aiProcessMessage(phone, message, userState) {
  const response = await openai.responses.create({
    model: "gpt-4.1",

    tools: [
      {
        type: "function",
        name: "createUserOnboarding",
        description: "Create a new VIXA user after onboarding.",
        parameters: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            pin: { type: "string" },
            phoneNumber: { type: "string" },
            email: { type: "string" },
          },
          required: ["firstName", "lastName", "pin", "phoneNumber", "email"],
        },
      },
      {
        type: "function",
        name: "verifyNIN",
        description: "Verify a user’s NIN to activate their wallet.",
        parameters: {
          type: "object",
          properties: {
            nin: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            dateOfBirth: { type: "string" },
          },
          required: ["nin", "firstName", "lastName", "dateOfBirth"],
        },
      },
    ],
    input: [
      {
        role: "system",
        content: `
You MUST ALWAYS respond in VALID JSON.

You are VIXA AI, responsible for onboarding new users.

⚠️ RULES:
- Ask for ONE field at a time.
- Never ask for multiple details in a single message.
- Never say "provide all details".
- Always follow the onboarding sequence exactly.
- Never skip steps.
- Never ask for NIN during onboarding.
- Never call createUserOnboarding until the last step.

✅ ONBOARDING SEQUENCE:
1. entry → ask: first name
2. collect_first_name → ask: last name
3. collect_last_name → ask: email
4. collect_email → ask: 4-digit PIN
5. collect_pin → ask: confirm PIN
6. confirm_pin → if matches → ready_to_create_account
7. ready_to_create_account → call createUserOnboarding

✅ AFTER ACCOUNT CREATION (ADDITIONAL SEQUENCE):
- After calling createUserOnboarding, send a reply informing the user their account has been created.
- In the SAME reply, immediately continue the flow by asking for the next field: NIN.
- Always treat this as a new required step; expect a user response.

✅ NIN + KYC SEQUENCE:
8. collect_nin → ask for the user's NIN
9. collect_dob → after receiving NIN, ask for the user's date of birth
10. After collecting date of birth → call verifyNIN tool

- The verifyNIN tool MUST receive:
   - firstName (from onboarding data)
  - lastName (from onboarding data)
  - nin (the newly provided NIN)
  - Do NOT change variable names.
  - dateOfBirth (from collect_dob)
 
     

✅ NORMAL RESPONSE FORMAT:
{
  "reply": "text shown to user",
  "nextState": "state_name",
  "data": {}
}

✅ TOOL CALL FORMAT:
{
  "type": "tool",
  "name": "createUserOnboarding",
  "arguments": { ... }
}
{  "type": "tool",
   "name": "verifyNIN",
   "arguments": { ... }
}

Only respond in JSON.

        `,
      },
      {
        role: "user",
        content: JSON.stringify({ phone, message, userState }),
      },
    ],
  });

  // MUST detect Responses API tool calls properly
  const toolItem = response.output.find((o) => o.type === "tool_call");

  if (toolItem) {
    return {
      type: "tool_call",
      tool: toolItem.name,
      arguments: toolItem.arguments,
      call_id: toolItem.call_id,
    };
  }

  // ✅ Normal message
  const messageItem = response.output.find((o) => o.type === "message");

  if (!messageItem) {
    throw new Error("Model did not return a message item");
  }

  const text = messageItem.content?.[0]?.text;

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("RAW MODEL OUTPUT:", text);
    throw new Error("Model did not return valid JSON");
  }
}
