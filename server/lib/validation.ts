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
});

export const InitiateSingleTransferSchema = z.object({
  bankCode: z.string().min(1, "Bank code is required"),
  accountNumber: z.string().min(1, "Account number is required"),
  accountName: z.string().optional(),
  amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
  remark: z.string().optional(),
  otp: z.string().length(6).regex(/^\d+$/).optional(),
  pin: z.string().length(4).regex(/^\d+$/, "PIN is required"),
  walletId: z.string().optional(),
});

export const InitiateBulkTransferSchema = z.object({
  type: z.enum(["Salary", "Epic"]),
  otp: z.string().length(6).regex(/^\d+$/).optional(),
  pin: z.string().length(4).regex(/^\d+$/, "PIN is required"),
  sourceWalletId: z.string().optional(),
  data: z.object({
    items: z.array(
      z.object({
        amount: z.union([z.number(), z.string().transform(Number)]).refine((v) => v > 0, "Amount must be positive"),
        bankCode: z.string().min(1, "Bank code is required"),
        accountNumber: z.string().min(1, "Account number is required"),
        accountName: z.string().optional(),
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
