exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { message, context: userContext } = JSON.parse(event.body);

  try {
    // First, check if this is a booking request
    const bookingIntent = await checkBookingIntent(message);

    if (bookingIntent.isBooking) {
      return await handleBooking(bookingIntent, message);
    }

    // Regular chat response
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
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
      }
    );

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: data.candidates[0].content.parts[0].text,
      }),
    };
  } catch (error) {
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
  ];
  const timeKeywords = ["today", "tomorrow", "pm", "am", "at", "on"];

  const lowerMessage = message.toLowerCase();
  const hasBookingKeyword = bookingKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );
  const hasTimeKeyword = timeKeywords.some((keyword) =>
    lowerMessage.includes(keyword)
  );

  if (hasBookingKeyword && hasTimeKeyword) {
    // Extract time using AI
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Extract the date and time from this booking request. Return ONLY a JSON object with date (YYYY-MM-DD) and time (HH:MM) in 24-hour format. If today, use today's date. If no specific date mentioned, assume today.

Message: "${message}"

Example response: {"date": "2024-07-18", "time": "18:30"}`,
                },
              ],
            },
          ],
        }),
      }
    );

    const data = await response.json();
    const timeInfo = JSON.parse(data.candidates[0].content.parts[0].text);

    return {
      isBooking: true,
      date: timeInfo.date,
      time: timeInfo.time,
    };
  }

  return { isBooking: false };
}

async function handleBooking(bookingIntent, originalMessage) {
  try {
    // Get available slots from Cal.com
    const availableSlots = await getAvailableSlots(bookingIntent.date);

    // Check if requested time is available
    const requestedDateTime = `${bookingIntent.date}T${bookingIntent.time}:00`;
    const isAvailable = availableSlots.some(
      (slot) => slot.time === requestedDateTime
    );

    if (!isAvailable) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: `Sorry, ${bookingIntent.time} on ${
            bookingIntent.date
          } is not available. Here are some available times: ${availableSlots
            .slice(0, 3)
            .map((slot) => new Date(slot.time).toLocaleTimeString())
            .join(", ")}`,
        }),
      };
    }

    // Book the slot
    const booking = await createBooking(requestedDateTime);

    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: `Great! I've booked your call for ${new Date(
          requestedDateTime
        ).toLocaleString()}. You'll receive a confirmation email shortly. Meeting link: ${
          booking.meetingUrl
        }`,
      }),
    };
  } catch (error) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: `Sorry, I couldn't book that time slot. Please try again or visit my calendar directly at [your-cal-link]`,
      }),
    };
  }
}

async function getAvailableSlots(date) {
  const response = await fetch(
    `https://api.cal.com/v1/slots?apikey=${process.env.CAL_API_KEY}&username=${process.env.CAL_USERNAME}&dateFrom=${date}&dateTo=${date}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  const data = await response.json();
  return data.slots || [];
}

async function createBooking(dateTime) {
  const response = await fetch(
    `https://api.cal.com/v1/bookings?apikey=${process.env.CAL_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventTypeId: process.env.CAL_EVENT_TYPE_ID, // Your event type ID
        start: dateTime,
        responses: {
          name: "Website Visitor",
          email: "visitor@example.com", // You might want to collect this
          notes: "Booked via AI assistant",
        },
      }),
    }
  );

  return await response.json();
}
