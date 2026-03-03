import fs from "fs";
import crypto from "crypto";

// --- Configuration ---
// IMPORTANT: Ensure this path or environment variable is correct.
// If running locally, make sure 'private.pem' is in the root directory.
const PRIVATE_KEY = fs.readFileSync("./private.pem", "utf8"); 

// --- Core Decryption Function ---
export const decryptRequest = (body) => {
  // Flows send the encrypted payload in three separate fields.
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
      console.error("Missing required fields for decryption.");
      // Throw a generic server error if fields are missing, or 421 if the data is just malformed
      throw { status: 400, message: "Missing encrypted fields" };
  }

  try {
    // 1. Decrypt the AES key using your Private Key (RSA)
    // This key is unique for this request.
    const decryptedAesKey = crypto.privateDecrypt(
      {
        key: crypto.createPrivateKey(PRIVATE_KEY),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted_aes_key, "base64")
    );

    // 2. Decrypt the Flow Data using the AES Key (AES-GCM)
    const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
    const initialVectorBuffer = Buffer.from(initial_vector, "base64");
    
    const TAG_LENGTH = 16;
    const encrypted_flow_data_body = flowDataBuffer.subarray(0, -TAG_LENGTH);
    const encrypted_flow_data_tag = flowDataBuffer.subarray(-TAG_LENGTH);

    const decipher = crypto.createDecipheriv(
      "aes-128-gcm",
      decryptedAesKey,
      initialVectorBuffer
    );
    decipher.setAuthTag(encrypted_flow_data_tag);

    const decryptedJSONString = Buffer.concat([
      decipher.update(encrypted_flow_data_body),
      decipher.final(),
    ]).toString("utf-8");

    // Return the decrypted JSON body and the AES key/IV for response encryption
    return {
      decryptedBody: JSON.parse(decryptedJSONString),
      aesKeyBuffer: decryptedAesKey,
      initialVectorBuffer,
    };
  } catch (error) {
    console.error("Critical Decryption Failure:", error);
    // WhatsApp requires HTTP 421 on decryption failure
    throw { status: 421, message: "Decryption failed" }; 
  }
};

// --- Core Encryption Function ---
export const encryptResponse = (
  response,
  aesKeyBuffer,
  initialVectorBuffer
) => {
  // 1. Flip the IV bits (required by WhatsApp protocol for the response)
  const flipped_iv = [];
  for (const pair of initialVectorBuffer.entries()) {
    // Invert the byte: 0xFF is 255
    flipped_iv.push(pair[1] ^ 0xFF); 
  }

  // 2. Encrypt the response JSON using the same AES key
  const cipher = crypto.createCipheriv(
    "aes-128-gcm",
    aesKeyBuffer,
    Buffer.from(flipped_iv)
  );
  
  // Encrypt the JSON string
  const encryptedData = Buffer.concat([
    cipher.update(JSON.stringify(response), "utf-8"),
    cipher.final(),
    cipher.getAuthTag(), // Append the authentication tag (16 bytes)
  ]);

  // 3. Return the encrypted data as a Base64 string (plain text response)
  return encryptedData.toString("base64");
};