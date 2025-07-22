exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { message, context: userContext } = JSON.parse(event.body);

  try {
    // Check if this is a booking request first
    const bookingIntent = await checkBookingIntent(message);

    console.log("Booking intent:", bookingIntent);

    if (bookingIntent.isBooking) {
      return await handleBooking(bookingIntent, message);
    }

    // Regular chat response
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You are a personal AI assistant for a software engineer. Only answer questions about this person based on the following information. If asked about anything else, politely redirect to questions about their professional background.

Personal Information:
${userContext}

Keep responses concise and professional. If you don't know something about them, say so.

User Question: ${message}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          topK: 1,
          topP: 1,
          maxOutputTokens: 150,
        },
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: data.candidates[0].content.parts[0].text,
      }),
    };
  } catch (error) {
    console.error("Error in chat handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to get response" }),
    };
  }
};

async function checkBookingIntent(message) {
  const bookingKeywords = [
    "book",
    "schedule",
    "appointment",
    "call",
    "meeting",
    "chat",
    "talk",
    "discuss",
    "consultation",
    "session",
  ];

  const timeKeywords = [
    "today",
    "tomorrow",
    "pm",
    "am",
    "at ",
    "on ",
    "morning",
    "afternoon",
    "evening",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];

  const lowerMessage = message.toLowerCase();

  const hasBookingKeyword = bookingKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );

  const hasTimeKeyword = timeKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );

  console.log("Message:", message);
  console.log("Has booking keyword:", hasBookingKeyword);
  console.log("Has time keyword:", hasTimeKeyword);

  // **FIX:** This now correctly identifies a follow-up by checking for any time-related keyword.
  if (hasTimeKeyword && !hasBookingKeyword) {
    // If a time is mentioned without a booking keyword, assume it's a booking continuation.
    return {
      isBooking: true,
      isGeneral: false,
      continueBooking: true,
    };
  }

  if (hasBookingKeyword) {
    // Check if it's a general booking request without a specific time
    if (!hasTimeKeyword) {
      return {
        isBooking: true,
        isGeneral: true,
      };
    }

    // If booking and time keywords are present, proceed to extract the details.
    // This path is taken for messages like "book a call for tomorrow at 3 PM"
    return {
      isBooking: true,
      isGeneral: false,
      continueBooking: false, // Not a continuation, but a new request with details
    };
  }

  return { isBooking: false };
}

async function handleBooking(bookingIntent, originalMessage) {
  try {
    // Handle general booking requests (without specific time)
    if (bookingIntent.isGeneral) {
      const calendarUrl = process.env.CAL_USERNAME
        ? `https://cal.com/${process.env.CAL_USERNAME}`
        : "your calendar";

      const replyMessage = `I'd be happy to help you schedule a call with Darshan! 

Here are a few options:
1. Visit his calendar directly: ${calendarUrl}
2. Let me know a preferred time (e.g., "tomorrow at 3 PM" or "Friday morning")

What works best for you?`;

      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: replyMessage,
        }),
      };
    }

    // **REVISED LOGIC:** Centralize the date/time extraction.
    // This block will now handle initial requests with time AND follow-up messages.
    let timeInfo;
    try {
      const currentDate = new Date().toISOString().split("T")[0];
      const promptText = `Extract the date and time from this booking request. Return ONLY a JSON object with date (YYYY-MM-DD) and time (HH:MM) in 24-hour format. If today, use today's date. If no specific date mentioned, assume today. If no specific time, return null for time.

Current date: ${currentDate}

Message: "${originalMessage}"

Example response: {"date": "2024-07-18", "time": "18:30"} or {"date": "2024-07-18", "time": null}`;

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: promptText,
                },
              ],
            },
          ],
        }),
      });

      const data = await response.json();
      timeInfo = JSON.parse(data.candidates[0].content.parts[0].text);

      // If time extraction fails or returns null time, treat as a general booking query
      if (!timeInfo || !timeInfo.time) {
        bookingIntent.isGeneral = true;
        return handleBooking(bookingIntent, originalMessage);
      }
    } catch (error) {
      console.error("Error extracting time:", error);
      // Fallback to general booking if time extraction fails.
      bookingIntent.isGeneral = true;
      return handleBooking(bookingIntent, originalMessage);
    }

    // Check if Cal.com API is configured
    if (!process.env.CAL_API_KEY || !process.env.CAL_USERNAME) {
      const calendarUrl = process.env.CAL_USERNAME
        ? `https://cal.com/${process.env.CAL_USERNAME}`
        : "his calendar";

      const fallbackMessage = `I'd love to help you schedule a call! Please visit ${calendarUrl} to book a time that works for you.

You can also reach out directly via email or LinkedIn for scheduling.`;

      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: fallbackMessage,
        }),
      };
    }

    // Get available slots from Cal.com
    const availableSlots = await getAvailableSlots(timeInfo.date);

    // Check if requested time is available
    const requestedDateTime = timeInfo.date + "T" + timeInfo.time + ":00";
    const isAvailable = availableSlots.some(
      (slot) => slot.time === requestedDateTime
    );

    if (!isAvailable) {
      const availableTimesText = availableSlots
        .slice(0, 3)
        .map((slot) => new Date(slot.time).toLocaleTimeString())
        .join(", ");

      const calendarLink = process.env.CAL_USERNAME
        ? `https://cal.com/${process.env.CAL_USERNAME}`
        : "his calendar";
      const unavailableMessage = `Sorry, ${timeInfo.time} on ${timeInfo.date} is not available. Here are some available times: ${availableTimesText}

Or you can view all available slots on ${calendarLink}`;

      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: unavailableMessage,
        }),
      };
    }

    // Book the slot
    const booking = await createBooking(requestedDateTime);
    const successMessage = `Great! I've booked your call for ${new Date(
      requestedDateTime
    ).toLocaleString()}. You'll receive a confirmation email shortly. Meeting link: ${
      booking.meetingUrl
    }`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: successMessage,
      }),
    };
  } catch (error) {
    console.error("Booking error:", error);
    const calendarLink = process.env.CAL_USERNAME
      ? `https://cal.com/${process.env.CAL_USERNAME}`
      : "his calendar";
    const errorMessage = `I'd be happy to help you schedule a call! Please visit ${calendarLink} to book a time.

Alternatively, you can reach out via email or LinkedIn to schedule.`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: errorMessage,
      }),
    };
  }
}

async function getAvailableSlots(date) {
  const apiUrl = `https://api.cal.com/v1/slots?apikey=${process.env.CAL_API_KEY}&username=${process.env.CAL_USERNAME}&dateFrom=${date}&dateTo=${date}`;

  const response = await fetch(apiUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();
  return data.slots || [];
}

async function createBooking(dateTime) {
  const apiUrl = `https://api.cal.com/v1/bookings?apikey=${process.env.CAL_API_KEY}`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      eventTypeId: process.env.CAL_EVENT_TYPE_ID,
      start: dateTime,
      responses: {
        name: "Website Visitor",
        email: "visitor@example.com",
        notes: "Booked via AI assistant",
      },
    }),
  });

  return await response.json();
}
