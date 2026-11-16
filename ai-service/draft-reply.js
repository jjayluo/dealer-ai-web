export function generateDraftReply({ vehicle, buyerMessage }) {
  const message = buyerMessage.toLowerCase();
  const car = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  const verificationNotes = [];

  if (/\b(test drive|appointment)\b/.test(message)) {
    return {
      draft: `Thanks for your interest in the ${car}! What day and time work for you? Our team will confirm availability before you head over.`,
      verificationNotes: ['Staff must confirm the vehicle and appointment time.'],
    };
  }

  if (/\b(accidents?|carfax|damage)\b/.test(message)) {
    return {
      draft: `Thanks for asking about the ${car}. I can have our team check the vehicle history and follow up before you make the trip.`,
      verificationNotes: [
        vehicle.history_summary
          ? 'Review the recorded history before replying.'
          : 'No verified vehicle history is on file.',
      ],
    };
  }

  if (/\b(miles|mileage)\b/.test(message) && Number.isInteger(vehicle.mileage)) {
    return {
      draft: `The ${car} has ${vehicle.mileage.toLocaleString('en-US')} miles on record. Would you like our team to confirm availability for a visit?`,
      verificationNotes,
    };
  }

  return {
    draft: `Thanks for asking about the ${car}! I can have our team check those details and follow up. Is there anything in particular you’d like us to verify?`,
    verificationNotes: ['Review the buyer’s question before sending.'],
  };
}
