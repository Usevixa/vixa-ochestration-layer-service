import OpenAI from "openai";

const apikey = process.env.OPENAI_API_KEY;
export const openai = new OpenAI({
  apiKey: apikey,
});
