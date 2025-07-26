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
        "I'd be happy to help you schedule a call! Please note that calls need to be booked at least 24 hours in advance. When would you like to meet? (e.g., 'day after tomorrow at 3 PM', 'next Monday at 10 AM')";
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
          "I couldn't understand that time. Could you please specify again? (e.g., 'day after tomorrow at 2 PM', 'December 25 at 10:30 AM')";
        break;
      }

      // Check if the time is at least 24 hours in the future
      const now = new Date();
      const selectedDate = new Date(selectedDateTime);
      const hoursUntilMeeting = (selectedDate - now) / (1000 * 60 * 60);

      if (hoursUntilMeeting < 24) {
        reply = `I'm sorry, but calls need to be booked at least 24 hours in advance. The earliest you can book is ${formatDateTime(
          new Date(now.getTime() + 24 * 60 * 60 * 1000)
        )}. Please choose a time after that.`;
        break;
      }

      // Check availability with Cal.com
      const availability = await checkCalcomAvailability(selectedDateTime);

      if (availability.isAvailable) {
        newState.selectedTime = selectedDateTime;
        newState.step = "ASK_DETAILS";
        reply = `Perfect! ${formatDateTime(
          selectedDateTime
        )} is available. To confirm your booking, I'll need your name and email address.`;
      } else {
        // Get alternative slots
        const alternatives = await getAlternativeSlots(selectedDateTime);
        newState.alternatives = alternatives;

        if (alternatives.length > 0) {
          reply = `I'm sorry, ${formatDateTime(
            selectedDateTime
          )} is not available. Here are some nearby available slots:\n\n${formatAlternatives(
            alternatives
          )}\n\nPlease choose one of these times or suggest another time.`;
        } else {
          reply = `I'm sorry, ${formatDateTime(
            selectedDateTime
          )} is not available, and I couldn't find nearby alternatives. Please try a different date or time (remember, it must be at least 24 hours from now).`;
        }
        newState.step = "WAITING_FOR_TIME";
      }

      // Clear alternatives after processing
      if (!availability.isAvailable) {
        newState.alternatives = alternatives;
      } else {
        delete newState.alternatives;
      }
      break;

    case "ASK_DETAILS":
      const details = message.split(",").map((s) => s.trim());
      const name = details[0];
      const email = details[1];

      if (!name || !email || !email.includes("@")) {
        reply =
          "Please make sure to fill in both your name and a valid email address in the form above.";
        // Don't change the step, keep it as ASK_DETAILS so form stays visible
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
        // Provide more specific error message
        if (booking.error === "API key not configured") {
          reply =
            "I'm sorry, the booking system is not properly configured. Please contact the administrator or try booking directly through the calendar link.";
        } else if (
          booking.error &&
          booking.error.includes("booking_time_out_of_bounds_error")
        ) {
          reply =
            "I'm sorry, that time slot cannot be booked as it doesn't meet the 24-hour advance notice requirement. Please choose a time at least 24 hours from now.";
          newState.step = "ASK_TIME";
          newState.bookingFlow = "ASK_TIME";
        } else if (booking.error && booking.error.includes("available")) {
          reply =
            "I'm sorry, that time slot is no longer available. Would you like to try booking a different time?";
          newState.step = "ASK_TIME";
          newState.bookingFlow = "ASK_TIME";
        } else {
          reply = `I'm sorry, there was an issue booking your call: ${
            booking.error || "Unknown error"
          }. Please try again or visit the calendar directly.`;
        }

        // Only reset state if it's a configuration error
        if (booking.error === "API key not configured") {
          newState = {};
        }
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
  // REVERTED to a known stable model for maximum reliability.
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const currentDate = new Date().toISOString();

  // The robust prompt with a generic example to avoid confusion.
  const prompt = `You are an expert date-time parser. Your task is to convert a user's natural language request into a precise ISO 8601 timestamp.
- The current date and time is: ${currentDate}. The user is in 'Asia/Kolkata' (IST).
- You MUST return ONLY the valid ISO 8601 string and nothing else.

Example:
User request: "next Tuesday at 4pm"
ISO 8601 Output: "2024-05-28T16:00:00.000Z"

Now, parse the following request based on the current date provided above:
User request: "${timeStr}"
ISO 8601 Output:`;

  try {
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 50 },
      }),
    });

    if (!response.ok) {
      console.error(
        "Gemini API Error:",
        response.status,
        await response.text()
      );
      return null;
    }

    const data = await response.json();
    const modelOutput = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!modelOutput) return null;

    // NEW: Use a regular expression to extract the ISO string. This is much more robust.
    const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/;
    const match = modelOutput.match(isoRegex);
    const dateStr = match ? match[0] : null;

    if (!dateStr) {
      console.error(
        "Could not extract ISO string from model output:",
        modelOutput
      );
      return null;
    }

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
  const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;

  if (!CAL_API_KEY || !CAL_EVENT_TYPE_ID) {
    console.error("Missing Cal.com credentials for availability check");
    return { isAvailable: true }; // Default to available if not configured
  }

  try {
    const startDate = new Date(dateTime);
    const endDate = new Date(startDate.getTime() + 30 * 60000); // 30 minutes later

    // Format dates for Cal.com API
    const startTime = startDate.toISOString();
    const endTime = endDate.toISOString();

    // Cal.com v1 availability endpoint
    const url = `https://api.cal.com/v1/availability?apiKey=${CAL_API_KEY}&eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${startTime}&endTime=${endTime}&timeZone=Asia/Kolkata`;

    console.log("Checking availability for:", startTime);

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        "Availability check failed:",
        response.status,
        await response.text()
      );
      return { isAvailable: true }; // Default to available on error
    }

    const data = await response.json();
    console.log("Availability response:", JSON.stringify(data, null, 2));

    // Check if the requested time slot exists in the busy array
    // If it's in the busy array, it's not available
    if (data.busy && Array.isArray(data.busy)) {
      const requestedTime = startDate.getTime();
      const isbusy = data.busy.some((busySlot) => {
        const busyStart = new Date(busySlot.start).getTime();
        const busyEnd = new Date(busySlot.end).getTime();
        return requestedTime >= busyStart && requestedTime < busyEnd;
      });

      return { isAvailable: !isbusy };
    }

    // If no busy data, assume available
    return { isAvailable: true };
  } catch (error) {
    console.error("Error checking availability:", error);
    return { isAvailable: true }; // Default to available on error
  }
}

/**
 * Get alternative time slots near the requested time
 */
async function getAlternativeSlots(requestedTime) {
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;

  if (!CAL_API_KEY || !CAL_EVENT_TYPE_ID) {
    return [];
  }

  try {
    const requestedDate = new Date(requestedTime);
    const startDate = new Date(requestedDate);

    // Look for slots within the next 7 days from the requested date
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    // Cal.com v1 slots endpoint
    const url = `https://api.cal.com/v1/slots?apiKey=${CAL_API_KEY}&eventTypeId=${CAL_EVENT_TYPE_ID}&startTime=${startDate.toISOString()}&endTime=${endDate.toISOString()}&timeZone=Asia/Kolkata`;

    console.log("Getting alternative slots...");

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("Failed to get slots:", response.status);
      return [];
    }

    const data = await response.json();
    console.log("Slots response:", data);

    if (!data.slots || !Array.isArray(data.slots)) {
      return [];
    }

    // Filter slots that are at least 24 hours from now
    const now = new Date();
    const minTime = now.getTime() + 24 * 60 * 60 * 1000;

    // Sort slots by proximity to requested time
    const requestedTimeMs = requestedDate.getTime();

    const validSlots = data.slots
      .filter((slot) => new Date(slot.time).getTime() >= minTime)
      .map((slot) => ({
        time: slot.time,
        diff: Math.abs(new Date(slot.time).getTime() - requestedTimeMs),
      }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 5)
      .map((slot) => slot.time);

    return validSlots;
  } catch (error) {
    console.error("Error getting alternatives:", error);
    return [];
  }
}

/**
 * Create a booking with Cal.com
 */
async function createCalcomBooking(dateTime, name, email) {
  const CAL_API_KEY = process.env.CAL_API_KEY;
  const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;

  if (!CAL_API_KEY) {
    console.error("CAL_API_KEY is not set in environment variables");
    return { success: false, error: "API key not configured" };
  }

  if (!CAL_EVENT_TYPE_ID) {
    console.error("CAL_EVENT_TYPE_ID is not set in environment variables");
    return { success: false, error: "Event type not configured" };
  }

  try {
    // Format the date properly for Cal.com
    const startDate = new Date(dateTime);

    // Cal.com v1 API booking endpoint
    const bookingPayload = {
      eventTypeId: parseInt(CAL_EVENT_TYPE_ID),
      start: startDate.toISOString(),
      responses: {
        name: name,
        email: email,
      },
      timeZone: "Asia/Kolkata",
      language: "en",
      metadata: {
        source: "ai-chat-bot",
      },
    };

    console.log(
      "Creating booking with payload:",
      JSON.stringify(bookingPayload, null, 2)
    );
    console.log(
      "Using API Key:",
      CAL_API_KEY ? `${CAL_API_KEY.substring(0, 10)}...` : "NOT SET"
    );

    // Try different authentication methods
    const headers = {
      "Content-Type": "application/json",
    };

    // Method 1: Bearer token (most common)
    headers["Authorization"] = `Bearer ${CAL_API_KEY}`;

    // Also try adding as query parameter
    const url = `https://api.cal.com/v1/bookings?apiKey=${CAL_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(bookingPayload),
    });

    const responseText = await response.text();
    console.log("Cal.com response status:", response.status);
    console.log("Cal.com response:", responseText);

    if (!response.ok) {
      // Try alternative method with API key in different format
      if (response.status === 401) {
        console.log("Trying alternative authentication method...");

        // Method 2: API key in header
        const altHeaders = {
          "Content-Type": "application/json",
          apiKey: CAL_API_KEY,
          "x-cal-api-key": CAL_API_KEY,
        };

        const altResponse = await fetch("https://api.cal.com/v1/bookings", {
          method: "POST",
          headers: altHeaders,
          body: JSON.stringify(bookingPayload),
        });

        const altResponseText = await altResponse.text();
        console.log(
          "Alternative method response:",
          altResponse.status,
          altResponseText
        );

        if (altResponse.ok) {
          const data = JSON.parse(altResponseText);
          return { success: true, booking: data };
        }
      }

      // Parse error message
      let errorMessage = "Booking failed";
      try {
        const errorData = JSON.parse(responseText);
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (e) {
        errorMessage = responseText || errorMessage;
      }

      return { success: false, error: errorMessage };
    }

    const data = JSON.parse(responseText);
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
