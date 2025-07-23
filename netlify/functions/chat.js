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
  // Initialize or copy the existing state. The first step is "START".
  let newState = { ...state, bookingStep: state.bookingStep || "START" };

  switch (newState.bookingStep) {
    // STATE 1: Starting the booking process
    case "START":
      newState.bookingStep = "AWAITING_TIME";
      reply =
        "I'd be happy to help schedule a call. What time works for you? (e.g., 'tomorrow at 3 PM')";
      break;

    // STATE 2: User has provided a time, now ask for details
    case "AWAITING_TIME":
      newState.bookingStep = "AWAITING_DETAILS";
      newState.time = message; // Save the user's requested time into the state
      reply = `Great. I'll check for availability for "${message}". Now, what is your full name and email address, separated by a comma? (e.g., "Jane Doe, jane.doe@example.com")`;
      break;

    // STATE 3: User has provided details, now validate and confirm
    case "AWAITING_DETAILS":
      const parts = message.split(",");
      const name = parts[0]?.trim();
      const email = parts[1]?.trim();

      // Basic validation for name and email format
      if (!name || !email || !email.includes("@")) {
        // If invalid, stay on this step and ask again
        newState.bookingStep = "AWAITING_DETAILS";
        reply =
          "That doesn't look right. Please provide your full name and a valid email, separated by a comma.";
      } else {
        // If valid, save the details and confirm the booking
        newState.name = name;
        newState.email = email;

        // --- Final Booking Step ---
        // Here you would call the real Cal.com API.
        // For now, we simulate a successful confirmation.
        reply = `Thank you, ${name}! Your call for "${newState.time}" is confirmed. A confirmation will be sent to ${email}.`;

        // Booking is complete, so we reset the state for the next conversation.
        newState = {};
      }
      break;

    // Default case for any unexpected errors
    default:
      reply =
        "Sorry, something went wrong with the booking process. Would you like to start over?";
      newState = {}; // Reset on error
      break;
  }

  // Return the reply and the new state to the client
  return { reply, conversationState: newState };
}
