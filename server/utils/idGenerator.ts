export function generateBusinessId(businessName: string): string {
  // Get initials
  const words = businessName.trim().split(/\s+/);
  let initials = "";
  
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0]).toUpperCase();
  } else if (words.length === 1 && words[0].length >= 2) {
    initials = words[0].substring(0, 2).toUpperCase();
  } else if (words.length === 1 && words[0].length === 1) {
    initials = words[0].toUpperCase() + "X"; // Pad with X if only 1 letter
  } else {
    initials = "XX"; // Fallback
  }

  // Ensure initials are alpha-numeric (remove symbols if any)
  initials = initials.replace(/[^A-Z0-9]/g, 'X');
  if (initials.length < 2) initials += 'X';

  // Generate 5 random alpha-numeric characters
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomPart = '';
  for (let i = 0; i < 5; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return initials + randomPart;
}
