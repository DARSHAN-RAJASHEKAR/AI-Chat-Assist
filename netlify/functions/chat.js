exports.handler = async (event, context) => {
  // Ensure the request is a POST request
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    // Extract the message, context, and the important conversationState object from the request
    const {
      message,
      context: userContext,
      conversationState = {},
    } = JSON.parse(event.body);

    // handleConversation will manage the entire logic flow, including state
    const response = await handleConversation(
      message,
      userContext,
      conversationState
    );

    // Return the response, which includes the reply and the *new* state
    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Error in chat handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to get a response from the assistant.",
      }),
    };
  }
};

/**
 * Determines whether to handle the message as part of a booking or as a general query.
 * @param {string} message - The user's message.
 * @param {string} userContext - The predefined context about the person (e.g., resume).
 * @param {object} conversationState - The current state of the conversation.
 * @returns {Promise<object>} An object with the reply and the updated conversation state.
 */
async function handleConversation(message, userContext, conversationState) {
  const lowerMessage = message.toLowerCase();
  const bookingKeywords = [
    "book",
    "schedule",
    "appointment",
    "call",
    "meeting",
  ];

  // Check if the user is trying to start a new booking conversation
  const isStartingBooking = bookingKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );

  // If we are already in a booking flow OR the user is starting one, use the booking handler
  if (conversationState.bookingStep || isStartingBooking) {
    return await handleBooking(message, conversationState);
  }

  // --- If not a booking, default to a General AI Chat Response ---
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const prompt = `You are a personal AI assistant for a software engineer. Only answer questions about this person based on the following information. If asked about anything else, politely redirect to questions about their professional background.

  Personal Information:
  ${userContext}
  
  Keep responses concise and professional. If you don't know something about them, say so.
  
  User Question: ${message}`;

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 150 },
    }),
  });

  if (!response.ok) {
    console.error(`Gemini API Error: ${response.statusText}`);
    return {
      reply:
        "Sorry, I'm having trouble connecting to my knowledge base. Please try again.",
      conversationState: {},
    };
  }

  const data = await response.json();
  const reply =
    data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "I'm sorry, I couldn't generate a response.";

  return {
    reply: reply,
    conversationState: {}, // Reset the state after any general (non-booking) question
  };
}

/**
 * Manages the multi-step booking process using a state machine.
 * @param {string} message - The user's current message.
 * @param {object} state - The current conversation state.
 * @returns {Promise<object>} An object with the reply and the new state.
 */
async function handleBooking(message, state) {
  let reply = "";
  let newState = { ...state, bookingStep: state.bookingStep || "START" };

  switch (newState.bookingStep) {
    case "START":
      newState.bookingStep = "AWAITING_TIME";
      reply =
        "I'd be happy to help schedule a call. What time works for you? (e.g., 'tomorrow at 3 PM')";
      break;

    case "AWAITING_TIME":
      newState.bookingStep = "AWAITING_DETAILS";
      newState.time = message; // Store the user's requested time
      reply = `Great. I'll check for availability for "${message}". Now, what is your full name and email address, separated by a comma? (e.g., "Jane Doe, jane.doe@example.com")`;
      break;

    case "AWAITING_DETAILS":
      const parts = message.split(",");
      const name = parts[0]?.trim();
      const email = parts[1]?.trim();

      if (!name || !email || !email.includes("@")) {
        newState.bookingStep = "AWAITING_DETAILS"; // Stay on this step
        reply =
          "That doesn't look right. Please provide your full name and a valid email, separated by a comma.";
      } else {
        newState.name = name;
        newState.email = email;

        // --- THIS BLOCK IS NOW ACTIVE ---
        try {
          // 1. Convert the natural language time to a machine-readable format
          const startDateTime = await parseDateTimeForAPI(newState.time);

          if (!startDateTime) {
            throw new Error("Could not determine a valid date and time.");
          }

          // 2. Call the real Cal.com API to create the booking
          const booking = await createBooking(
            startDateTime,
            newState.name,
            newState.email
          );

          if (booking && booking.id) {
            reply = `Thank you, ${name}! Your call for "${newState.time}" is confirmed. A confirmation has been sent to ${email}.`;
            newState = {}; // Reset state after successful booking
          } else {
            reply =
              "I'm sorry, I couldn't book that time. It might not be available. Please try another time.";
            newState.bookingStep = "AWAITING_TIME"; // Go back to asking for a time
          }
        } catch (error) {
          console.error("Booking process error:", error);
          reply =
            "I encountered an error while trying to book your call. Please try again later or visit the calendar directly.";
          newState = {}; // Reset on error
        }
      }
      break;

    default:
      reply = "Sorry, something went wrong. Would you like to start over?";
      newState = {}; // Reset on error
      break;
  }

  return { reply, conversationState: newState };
}

/**
 * Uses AI to parse a natural language string into an ISO 8601 datetime format.
 * @param {string} timeStr - The natural language time (e.g., "tomorrow at 3pm").
 * @returns {Promise<string|null>} - An ISO 8601 string (e.g., "2025-07-24T15:00:00.000Z") or null.
 */
async function parseDateTimeForAPI(timeStr) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const currentDate = new Date().toISOString();

  const prompt = `Given the current date is ${currentDate}, convert the following user request into a strict ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ). Assume the timezone is India Standard Time (IST, UTC+5:30).

    User request: "${timeStr}"
    
    Return ONLY the ISO 8601 string.`;

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}
