exports.handler = async (event, context) => {
  // Ensure the request is a POST request
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    // Extract the message, context, and conversationState from the request
    const {
      message,
      context: userContext,
      conversationState = {},
    } = JSON.parse(event.body);

    // Handle the conversation flow
    const response = await handleConversation(
      message,
      userContext,
      conversationState
    );

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
 * Manages the conversation flow between general queries and booking
 */
async function handleConversation(message, userContext, conversationState) {
  const lowerMessage = message.toLowerCase();
  const bookingKeywords = [
    "book",
    "schedule",
    "appointment",
    "call",
    "meeting",
    "talk",
    "chat",
    "connect",
  ];

  // Check if user wants to book a call
  const isBookingRequest = bookingKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );

  // If in booking flow or starting one
  if (conversationState.bookingFlow || isBookingRequest) {
    return await handleBookingFlow(message, conversationState);
  }

  // Handle general queries
  return await handleGeneralQuery(message, userContext);
}

/**
 * Handles general AI chat responses
 */
async function handleGeneralQuery(message, userContext) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const prompt = `You are a personal AI assistant for a software engineer. Only answer questions about this person based on the following information. If asked about anything else, politely redirect to questions about their professional background.

  Personal Information:
  ${userContext}
  
  Keep responses concise and professional. If you don't know something about them, say so.
  
  User Question: ${message}`;

  try {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 150 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API Error: ${response.statusText}`);
    }

    const data = await response.json();
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I'm sorry, I couldn't generate a response.";

    return {
      reply: reply,
      conversationState: {},
    };
  } catch (error) {
    console.error("Error in general query:", error);
    return {
      reply:
        "Sorry, I'm having trouble processing your request. Please try again.",
      conversationState: {},
    };
  }
}

/**
 * Handles the booking flow with Cal.com integration
 */
async function handleBookingFlow(message, state) {
  let newState = { ...state };
  let reply = "";

  // Initialize booking flow if not already started
  if (!newState.bookingFlow) {
    newState.bookingFlow = "ASK_TIME";
    newState.step = "ASK_TIME";
  }

  switch (newState.step) {
    case "ASK_TIME":
      reply =
        "I'd be happy to help you schedule a call! When would you like to meet? (e.g., 'tomorrow at 3 PM', 'next Monday at 10 AM')";
      newState.step = "WAITING_FOR_TIME";
      break;

    case "WAITING_FOR_TIME":
      // Check if user selected from alternatives
      let selectedDateTime = null;

      // First try to parse as a selection from alternatives
      if (newState.alternatives) {
        const lowerMessage = message.toLowerCase();
        for (let alt of newState.alternatives) {
          if (
            lowerMessage.includes(formatDateTime(alt).toLowerCase()) ||
            message === formatDateTime(alt)
          ) {
            selectedDateTime = alt;
            break;
          }
        }
      }

      // If not found in alternatives, parse as new time
      if (!selectedDateTime) {
        selectedDateTime = await parseDateTime(message);
      }

      if (!selectedDateTime) {
        reply =
          "I couldn't understand that time. Could you please specify again? (e.g., 'tomorrow at 2 PM', 'December 25 at 10:30 AM')";
        break;
      }

      // For now, skip availability check and proceed directly
      // This allows booking to work while we debug the Cal.com API
      newState.selectedTime = selectedDateTime;
      newState.step = "ASK_DETAILS";
      reply = `Great! I'll book your call for ${formatDateTime(
        selectedDateTime
      )}. To confirm your booking, I'll need your name and email address. Please provide them separated by a comma (e.g., "John Doe, john@example.com")`;

      // Clear alternatives after selection
      delete newState.alternatives;
      break;

    case "ASK_DETAILS":
      const details = message.split(",").map((s) => s.trim());
      const name = details[0];
      const email = details[1];

      if (!name || !email || !email.includes("@")) {
        reply =
          "Please provide both your name and email address separated by a comma (e.g., 'Jane Smith, jane@email.com')";
        break;
      }

      // Create booking with Cal.com
      const booking = await createCalcomBooking(
        newState.selectedTime,
        name,
        email
      );

      if (booking.success) {
        reply = `Perfect! Your call has been booked for ${formatDateTime(
          newState.selectedTime
        )}. A confirmation email has been sent to ${email}. Looking forward to speaking with you!`;
        newState = {}; // Reset state
      } else {
        reply =
          "I'm sorry, there was an issue booking your call. Please try again or visit my calendar directly.";
        newState = {}; // Reset state
      }
      break;

    default:
      reply =
        "Something went wrong. Would you like to start over with booking a call?";
      newState = {};
  }

  return { reply, conversationState: newState };
}

/**
 * Parse natural language datetime using Gemini
 */
async function parseDateTime(timeStr) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const currentDate = new Date().toISOString();

  const prompt = `Current date/time: ${currentDate}
  User timezone: India Standard Time (IST, UTC+5:30)
  
  Convert this request to ISO 8601 format: "${timeStr}"
  
  Return ONLY the ISO string, nothing else.`;

  try {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 50 },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const dateStr = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    // Validate the date
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : dateStr;
  } catch (error) {
    console.error("Error parsing datetime:", error);
    return null;
  }
}

/**
 * Check availability with Cal.com API
 */
async function checkCalcomAvailability(dateTime) {
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const CAL_USERNAME = process.env.CAL_USERNAME; // Add username to env vars

  try {
    // Parse the date properly
    const requestedDate = new Date(dateTime);
    const dateStr = requestedDate.toISOString().split("T")[0]; // YYYY-MM-DD format

    // Cal.com v2 API endpoint for availability
    const response = await fetch(
      `https://api.cal.com/v2/slots/available?startTime=${dateStr}&endTime=${dateStr}&username=${CAL_USERNAME}`,
      {
        headers: {
          Authorization: `Bearer ${CAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error("Cal.com availability check failed:", response.statusText);
      // If API fails, assume available to allow booking attempt
      return { isAvailable: true };
    }

    const data = await response.json();

    // Check if any slot matches the requested time
    const requestedHour = requestedDate.getHours();
    const requestedMinute = requestedDate.getMinutes();

    const isAvailable =
      data.data?.some((slot) => {
        const slotDate = new Date(slot.startTime);
        return (
          slotDate.getHours() === requestedHour &&
          slotDate.getMinutes() === requestedMinute
        );
      }) || false;

    // If no slots data, assume available
    if (!data.data || data.data.length === 0) {
      return { isAvailable: true };
    }

    return { isAvailable };
  } catch (error) {
    console.error("Error checking availability:", error);
    // Default to available if API fails to allow booking attempt
    return { isAvailable: true };
  }
}

/**
 * Get alternative time slots near the requested time
 */
async function getAlternativeSlots(requestedTime) {
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;

  try {
    const startDate = new Date(requestedTime);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7); // Check next 7 days

    const response = await fetch(
      `https://api.cal.com/v1/availability?eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${startDate.toISOString()}&endTime=${endDate.toISOString()}`,
      {
        headers: {
          Authorization: `Bearer ${CAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error("Failed to fetch availability");
    }

    const data = await response.json();

    // Get up to 5 slots nearest to requested time
    const slots = data.slots || [];
    const requestedTimeMs = new Date(requestedTime).getTime();

    return slots
      .map((slot) => ({
        time: slot.time,
        diff: Math.abs(new Date(slot.time).getTime() - requestedTimeMs),
      }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 5)
      .map((slot) => slot.time);
  } catch (error) {
    console.error("Error getting alternatives:", error);
    // Return some default slots if API fails
    const alternatives = [];
    const baseTime = new Date(requestedTime);

    for (let i = 1; i <= 3; i++) {
      const altTime = new Date(baseTime);
      altTime.setDate(altTime.getDate() + i);
      alternatives.push(altTime.toISOString());
    }

    return alternatives;
  }
}

/**
 * Create a booking with Cal.com
 */
async function createCalcomBooking(dateTime, name, email) {
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;
  const CAL_USERNAME = process.env.CAL_USERNAME;

  try {
    // First, try the v2 API
    const bookingData = {
      start: dateTime,
      eventTypeSlug: process.env.CAL_EVENT_SLUG || "30min", // Add event slug to env
      username: CAL_USERNAME,
      name: name,
      email: email,
      timeZone: "Asia/Kolkata",
      language: "en",
      metadata: {
        source: "ai-chat-bot",
      },
    };

    // Try v2 endpoint first
    let response = await fetch("https://api.cal.com/v2/bookings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bookingData),
    });

    // If v2 fails, try v1
    if (!response.ok) {
      console.log("V2 API failed, trying V1...");

      response = await fetch("https://api.cal.com/v1/bookings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CAL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventTypeId: parseInt(CAL_EVENT_TYPE_ID),
          start: dateTime,
          responses: {
            name: name,
            email: email,
          },
          timeZone: "Asia/Kolkata",
          language: "en",
          metadata: {
            source: "ai-chat-bot",
          },
        }),
      });
    }

    if (!response.ok) {
      const errorData = await response.text();
      console.error("Cal.com booking failed:", errorData);
      return { success: false, error: errorData };
    }

    const data = await response.json();
    return { success: true, booking: data };
  } catch (error) {
    console.error("Error creating booking:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Format datetime for display
 */
function formatDateTime(dateTimeStr) {
  const date = new Date(dateTimeStr);
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true,
    timeZone: "Asia/Kolkata",
  };

  return date.toLocaleString("en-US", options);
}

/**
 * Format alternative slots for display
 */
function formatAlternatives(alternatives) {
  return alternatives
    .map((alt, index) => `${index + 1}. ${formatDateTime(alt)}`)
    .join("\n");
}
