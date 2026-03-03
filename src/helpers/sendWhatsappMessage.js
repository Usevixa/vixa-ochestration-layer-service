// helpers/sendWhatsappMessage.js
// import fetch from "node-fetch";

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // set this in env

export async function sendWhatsappMessage(phone, text, phoneNumberId) {
  if (!phoneNumberId) {
    console.warn("Missing phoneNumberId for sendWhatsappMessage");
  }
  try {
    await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        text: { body: text },
      }),
    });
  } catch (err) {
    console.error("sendWhatsappMessage ERROR:", err);
  }
}
