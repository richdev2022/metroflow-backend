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
  bankCode: z.string().min(1, "Bank code is required"),
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
});

export const InitiateBulkTransferSchema = z.object({
  type: z.enum(["Salary", "Epic"]),
  otp: z.string().length(6).regex(/^\d+$/).optional(),
  pin: z.string().length(4).regex(/^\d+$/, "PIN is required"),
  sourceWalletId: z.string().optional(),
  source_wallet_id: z.string().optional(),
  data: z.object({
    items: z.array(
      z.object({
        amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
        bankCode: z.string().min(1, "Bank code is required"),
        accountNumber: z.string().min(1, "Account number is required"),
        accountName: z.string().optional(),
        currency: z.string().length(3).optional(),
        remark: z.string().optional(),
      })
    ).optional(),
  }).optional(),
});

export type CreateTransactionPinInput = z.infer<typeof CreateTransactionPinSchema>;
export type UpdateTransactionPinInput = z.infer<typeof UpdateTransactionPinSchema>;
export type ToggleOtpInput = z.infer<typeof ToggleOtpSchema>;
export type InitiateSingleTransferInput = z.infer<typeof InitiateSingleTransferSchema>;
export type InitiateBulkTransferInput = z.infer<typeof InitiateBulkTransferSchema>;
