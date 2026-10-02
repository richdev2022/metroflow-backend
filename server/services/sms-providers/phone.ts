/**
 * Shared phone-number normalization for SMS/WhatsApp providers.
 *
 * Providers in this stack (KudiSMS, Termii, Meta) expect Nigerian numbers in
 * international format WITHOUT a leading "+" — e.g. 2348012345678.
 *
 * Handles the common shapes users store:
 *   08012345678      -> 2348012345678
 *   +2348012345678   -> 2348012345678
 *   234 801 234 5678 -> 2348012345678
 *   23408012345678   -> 2348012345678 (country code + accidental leading 0)
 *   +447911123456    -> 447911123456 (non-NG international passes through)
 */
export function normalizePhone(to: string): string {
    let phone = (to || '').trim().replace(/[\s\-().]/g, '');

    if (phone.startsWith('+')) {
        phone = phone.slice(1);
    }

    // Nigeria: "234" + 11-digit local "08012345678" = 14 digits -> drop the stray 0
    if (phone.startsWith('2340') && phone.length === 14) {
        phone = '234' + phone.slice(4);
    }

    // Nigeria local format: 0 + 10 digits = 11 digits
    if (phone.startsWith('0') && phone.length === 11) {
        phone = '234' + phone.slice(1);
    }

    return phone;
}
