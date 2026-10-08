import { z } from "zod";

export const CreateTransactionPinSchema = z.object({
  pin: z.string().length(4).regex(/^\d+$/, "PIN must be 4 digits"),
});

export const UpdateTransactionPinSchema = z.object({
  newPin: z.string().length(4).regex(/^\d+$/, "New PIN must be 4 digits"),
  otp: z.string().length(6).regex(/^\d+$/, "OTP must be 6 digits"),
});

export const ToggleOtpSchema = z.object({
  enabled: z.boolean(),
  // Flipping the OTP-for-transactions switch is security-sensitive: an OTP
  // confirmation is required to effect the change (mirrors the PIN update).
  otp: z.string().length(6).regex(/^\d+$/, "OTP must be 6 digits"),
});

export const InitiateSingleTransferSchema = z.object({
  // Optional: international (USD/GBP/EUR) payouts have no NGN bank code — the
  // route validates bankCode presence per-currency instead.
  bankCode: z.string().optional(),
  accountNumber: z.string().min(1, "Account number is required"),
  accountName: z.string().optional(),
  amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
  currency: z.string().length(3).regex(/^[A-Z]+$/, "Currency must be a 3-letter code").optional(),
  remark: z.string().optional(),
  otp: z.string().length(6).regex(/^\d+$/).optional(),
  pin: z.string().length(4).regex(/^\d+$/, "PIN is required"),
  walletId: z.string().optional(),
  wallet_id: z.string().optional(),
  // ---- International payout beneficiary details (Flutterwave rails) ----
  // Required for corridors like USD ACH/SWIFT: street address, city, postal
  // code and ISO-2 country; state/SWIFT/routing depend on the destination.
  recipientAddress: z.string().max(200).optional(),
  recipientCity: z.string().max(100).optional(),
  recipientState: z.string().max(100).optional(),
  recipientPostalCode: z.string().max(20).optional(),
  recipientCountry: z.string().length(2).regex(/^[A-Za-z]{2}$/, "Country must be an ISO-2 code").optional(),
  bankName: z.string().max(150).optional(),
  swiftCode: z.string().max(20).optional(),
  routingNumber: z.string().max(20).optional(),
  /** USD: "checking" | "depository". GBP: "personal" | "corporate". */
  accountType: z.string().max(20).optional(),
  account_type: z.string().max(20).optional(),
  /** Beneficiary email — required by the USD meta[0] contract. */
  beneficiaryEmail: z.string().max(160).optional(),
  beneficiary_email: z.string().max(160).optional(),
  /** Explicit street components (EUR/GBP meta[0]) — derived from the address when absent. */
  recipientStreetNumber: z.string().max(20).optional(),
  recipientStreetName: z.string().max(200).optional(),
  recipient_street_number: z.string().max(20).optional(),
  recipient_street_name: z.string().max(200).optional(),
});

export const InitiateBulkTransferSchema = z.object({
  type: z.enum(["Salary", "Epic"]),
  otp: z.string().length(6).regex(/^\d+$/).optional(),
  pin: z.string().length(4).regex(/^\d+$/, "PIN is required"),
  sourceWalletId: z.string().optional(),
  source_wallet_id: z.string().optional(),
  /** Epic id the payout belongs to (new web/mobile contract). */
  epicId: z.string().optional(),
  /** New-contract top-level items; legacy clients still send data.items. */
  items: z
    .array(
      z.object({
        amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
        bankCode: z.string().optional(),
        accountNumber: z.string().min(1, "Account number is required"),
        accountName: z.string().optional(),
        currency: z.string().length(3).optional(),
        remark: z.string().optional(),
        // International (USD/GBP/EUR) beneficiary fields.
        recipientBankName: z.string().optional(),
        bankName: z.string().optional(),
        recipientSwiftCode: z.string().optional(),
        swiftCode: z.string().optional(),
        recipientRoutingNumber: z.string().optional(),
        routingNumber: z.string().optional(),
        recipientAddress: z.string().optional(),
        recipientCity: z.string().optional(),
        recipientState: z.string().optional(),
        recipientPostalCode: z.string().optional(),
        recipientCountry: z.string().optional(),
        beneficiaryEmail: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.string().email().optional()),
        accountType: z.string().max(20).optional(),
        account_type: z.string().max(20).optional(),
        recipientStreetNumber: z.string().max(20).optional(),
        recipientStreetName: z.string().max(200).optional(),
      }),
    )
    .optional(),
  data: z
    .object({
      items: z
        .array(
          z.object({
            amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
            bankCode: z.string().optional(),
            accountNumber: z.string().min(1, "Account number is required"),
            accountName: z.string().optional(),
            currency: z.string().length(3).optional(),
            remark: z.string().optional(),
            recipientBankName: z.string().optional(),
            bankName: z.string().optional(),
            recipientSwiftCode: z.string().optional(),
            swiftCode: z.string().optional(),
            recipientRoutingNumber: z.string().optional(),
            routingNumber: z.string().optional(),
            recipientAddress: z.string().optional(),
            recipientCity: z.string().optional(),
            recipientState: z.string().optional(),
            recipientPostalCode: z.string().optional(),
            recipientCountry: z.string().optional(),
            beneficiaryEmail: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.string().email().optional()),
            accountType: z.string().max(20).optional(),
            account_type: z.string().max(20).optional(),
            recipientStreetNumber: z.string().max(20).optional(),
            recipientStreetName: z.string().max(200).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type CreateTransactionPinInput = z.infer<typeof CreateTransactionPinSchema>;
export type UpdateTransactionPinInput = z.infer<typeof UpdateTransactionPinSchema>;
export type ToggleOtpInput = z.infer<typeof ToggleOtpSchema>;
export type InitiateSingleTransferInput = z.infer<typeof InitiateSingleTransferSchema>;
export type InitiateBulkTransferInput = z.infer<typeof InitiateBulkTransferSchema>;
