import { useState, useEffect } from "react";
import { usePaymentMethods } from "@/hooks/usePaymentMethods";
import { useBranch } from "@/contexts/BranchContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Building2, Smartphone, CreditCard, Banknote, Bitcoin } from "lucide-react";
import {
  OrganizationPaymentMethod,
  PaymentMethodInput,
  PaymentMethodType,
  BankPaymentDetails,
  MobileMoneyDetails,
  OnlinePaymentDetails,
  CashPaymentDetails,
  CryptoPaymentDetails,
  PAYMENT_METHOD_TYPES,
  MOBILE_MONEY_PROVIDERS,
  ONLINE_PAYMENT_PROVIDERS,
  CRYPTO_CURRENCIES,
} from "@/types/paymentMethod";

interface BankAccount {
  id: string;
  name: string;
  account_number: string | null;
  bank_name: string | null;
  currency: string | null;
}

interface AddPaymentMethodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingMethod: OrganizationPaymentMethod | null;
  bankAccounts: BankAccount[];
}

const typeIcons: Record<PaymentMethodType, React.ReactNode> = {
  bank: <Building2 className="h-4 w-4" />,
  mobile_money: <Smartphone className="h-4 w-4" />,
  online: <CreditCard className="h-4 w-4" />,
  cash: <Banknote className="h-4 w-4" />,
  crypto: <Bitcoin className="h-4 w-4" />,
};

export function AddPaymentMethodDialog({
  open,
  onOpenChange,
  editingMethod,
  bankAccounts,
}: AddPaymentMethodDialogProps) {
  const { createPaymentMethod, updatePaymentMethod, isCreating, isUpdating } = usePaymentMethods();
  const { branches } = useBranch();
  const isEditing = !!editingMethod;
  const isSaving = isCreating || isUpdating;

  // Form state
  const [type, setType] = useState<PaymentMethodType>("bank");
  const [label, setLabel] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [qrCodeEnabled, setQrCodeEnabled] = useState(false);
  const [linkToBankAccount, setLinkToBankAccount] = useState(false);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>("");
  const [branchScope, setBranchScope] = useState<string>("__all__");

  // Bank details
  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [branch, setBranch] = useState("");
  const [swiftCode, setSwiftCode] = useState("");
  const [iban, setIban] = useState("");

  // Mobile money details
  const [mobileProvider, setMobileProvider] = useState<MobileMoneyDetails["provider"]>("mpesa");
  const [paybillNumber, setPaybillNumber] = useState("");
  const [tillNumber, setTillNumber] = useState("");
  const [mobileAccountNumber, setMobileAccountNumber] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");

  // Online payment details
  const [onlineProvider, setOnlineProvider] = useState<OnlinePaymentDetails["provider"]>("paypal");
  const [onlineEmail, setOnlineEmail] = useState("");
  const [onlineUsername, setOnlineUsername] = useState("");
  const [paymentLink, setPaymentLink] = useState("");

  // Cash details
  const [cashInstructions, setCashInstructions] = useState("");

  // Crypto details
  const [cryptoCurrency, setCryptoCurrency] = useState<CryptoPaymentDetails["currency"]>("btc");
  const [walletAddress, setWalletAddress] = useState("");
  const [cryptoNetwork, setCryptoNetwork] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (editingMethod) {
        // Populate form with existing values
        setType(editingMethod.type);
        setLabel(editingMethod.label);
        setIsDefault(editingMethod.is_default);
        setQrCodeEnabled(editingMethod.qr_code_enabled);
        setLinkToBankAccount(!!editingMethod.bank_account_id);
        setSelectedBankAccountId(editingMethod.bank_account_id || "");
        // Branch scope (read directly off the row — typed model omits it)
        const branchOnRow =
          (editingMethod as unknown as { branch_id?: string | null }).branch_id ?? null;
        setBranchScope(branchOnRow ?? "__all__");

        const details = editingMethod.details;
        
        switch (editingMethod.type) {
          case "bank":
            const bankDetails = details as BankPaymentDetails;
            setBankName(bankDetails.bank_name || "");
            setAccountName(bankDetails.account_name || "");
            setAccountNumber(bankDetails.account_number || "");
            setBranch(bankDetails.branch || "");
            setSwiftCode(bankDetails.swift_code || "");
            setIban(bankDetails.iban || "");
            break;
          case "mobile_money":
            const mobileDetails = details as MobileMoneyDetails;
            setMobileProvider(mobileDetails.provider || "mpesa");
            setPaybillNumber(mobileDetails.paybill_number || "");
            setTillNumber(mobileDetails.till_number || "");
            setMobileAccountNumber(mobileDetails.account_number || "");
            setPhoneNumber(mobileDetails.phone_number || "");
            break;
          case "online":
            const onlineDetails = details as OnlinePaymentDetails;
            setOnlineProvider(onlineDetails.provider || "paypal");
            setOnlineEmail(onlineDetails.email || "");
            setOnlineUsername(onlineDetails.username || "");
            setPaymentLink(onlineDetails.payment_link || "");
            break;
          case "cash":
            const cashDetails = details as CashPaymentDetails;
            setCashInstructions(cashDetails.instructions || "");
            break;
          case "crypto":
            const cryptoDetails = details as CryptoPaymentDetails;
            setCryptoCurrency(cryptoDetails.currency || "btc");
            setWalletAddress(cryptoDetails.wallet_address || "");
            setCryptoNetwork(cryptoDetails.network || "");
            break;
        }
      } else {
        // Reset to defaults
        setType("bank");
        setLabel("");
        setIsDefault(false);
        setQrCodeEnabled(false);
        setLinkToBankAccount(false);
        setSelectedBankAccountId("");
        setBranchScope("__all__");
        setBankName("");
        setAccountName("");
        setAccountNumber("");
        setBranch("");
        setSwiftCode("");
        setIban("");
        setMobileProvider("mpesa");
        setPaybillNumber("");
        setTillNumber("");
        setMobileAccountNumber("");
        setPhoneNumber("");
        setOnlineProvider("paypal");
        setOnlineEmail("");
        setOnlineUsername("");
        setPaymentLink("");
        setCashInstructions("");
        setCryptoCurrency("btc");
        setWalletAddress("");
        setCryptoNetwork("");
      }
    }
  }, [open, editingMethod]);

  // Auto-populate from selected bank account
  useEffect(() => {
    if (linkToBankAccount && selectedBankAccountId) {
      const account = bankAccounts.find((a) => a.id === selectedBankAccountId);
      if (account) {
        setBankName(account.bank_name || "");
        setAccountName(account.name || "");
        setAccountNumber(account.account_number || "");
        if (!label) {
          setLabel(`${account.bank_name || "Bank"} - ${account.name}`);
        }
      }
    }
  }, [linkToBankAccount, selectedBankAccountId, bankAccounts, label]);

  const buildDetails = (): PaymentMethodInput["details"] => {
    switch (type) {
      case "bank":
        return {
          bank_name: bankName,
          account_name: accountName,
          account_number: accountNumber,
          branch: branch || undefined,
          swift_code: swiftCode || undefined,
          iban: iban || undefined,
        } as BankPaymentDetails;
      case "mobile_money":
        return {
          provider: mobileProvider,
          paybill_number: paybillNumber || undefined,
          till_number: tillNumber || undefined,
          account_number: mobileAccountNumber || undefined,
          phone_number: phoneNumber || undefined,
        } as MobileMoneyDetails;
      case "online":
        return {
          provider: onlineProvider,
          email: onlineEmail || undefined,
          username: onlineUsername || undefined,
          payment_link: paymentLink || undefined,
        } as OnlinePaymentDetails;
      case "cash":
        return {
          instructions: cashInstructions || undefined,
        } as CashPaymentDetails;
      case "crypto":
        return {
          currency: cryptoCurrency,
          wallet_address: walletAddress,
          network: cryptoNetwork || undefined,
        } as CryptoPaymentDetails;
    }
  };

  const handleSubmit = () => {
    if (!label.trim()) return;

    const input: PaymentMethodInput = {
      type,
      label: label.trim(),
      details: buildDetails(),
      is_default: isDefault,
      qr_code_enabled: qrCodeEnabled,
      bank_account_id: linkToBankAccount ? selectedBankAccountId : null,
    };

    const payload: PaymentMethodInput = {
      ...input,
      branch_id: branchScope === "__all__" ? null : branchScope,
    };

    if (isEditing) {
      updatePaymentMethod({ id: editingMethod.id, ...payload });
    } else {
      createPaymentMethod(payload);
    }

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Payment Method" : "Add Payment Method"}
          </DialogTitle>
          <DialogDescription>
            Configure a payment option to display on repayment receipts and statements.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Type Selection */}
          <div className="space-y-3">
            <Label>Payment Type</Label>
            <RadioGroup
              value={type}
              onValueChange={(v) => setType(v as PaymentMethodType)}
              className="grid grid-cols-2 gap-2"
              disabled={isEditing}
            >
              {(Object.keys(PAYMENT_METHOD_TYPES) as PaymentMethodType[]).map((t) => (
                <div key={t}>
                  <RadioGroupItem value={t} id={t} className="peer sr-only" />
                  <Label
                    htmlFor={t}
                    className="flex items-center gap-2 rounded-md border-2 border-muted bg-popover p-3 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary cursor-pointer"
                  >
                    {typeIcons[t]}
                    <span className="text-sm font-medium">
                      {PAYMENT_METHOD_TYPES[t].label}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Label */}
          <div className="space-y-2">
            <Label htmlFor="label">Display Label *</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`e.g., ${PAYMENT_METHOD_TYPES[type].label} - Main Account`}
            />
            <p className="text-xs text-muted-foreground">
              This is how it will appear on your documents
            </p>
          </div>

          {/* Branch scope — NULL = company-wide; non-null = single branch only.
              Validated by the DB trigger enforce_branch_business_match. */}
          {branches.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="branch-scope">Available at</Label>
              <Select value={branchScope} onValueChange={setBranchScope}>
                <SelectTrigger id="branch-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All branches (company-wide)</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                      {b.is_headquarters ? " (HQ)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Restrict this method to documents issued from one branch, or leave it
                available across the whole company.
              </p>
            </div>
          )}

          {/* Type-specific fields */}
          {type === "bank" && (
            <div className="space-y-4">
              {bankAccounts.length > 0 && (
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Link to Banking Module</Label>
                    <p className="text-xs text-muted-foreground">
                      Auto-sync from your bank accounts
                    </p>
                  </div>
                  <Switch
                    checked={linkToBankAccount}
                    onCheckedChange={setLinkToBankAccount}
                  />
                </div>
              )}

              {linkToBankAccount ? (
                <div className="space-y-2">
                  <Label>Select Bank Account</Label>
                  <Select
                    value={selectedBankAccountId}
                    onValueChange={setSelectedBankAccountId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a bank account" />
                    </SelectTrigger>
                    <SelectContent>
                      {bankAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.bank_name || "Bank"} - {account.name} (****
                          {(account.account_number || "").slice(-4)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bank_name">Bank Name *</Label>
                  <Input
                    id="bank_name"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g., KCB Bank"
                    disabled={linkToBankAccount}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account_name">Account Name *</Label>
                  <Input
                    id="account_name"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    placeholder="e.g., ACME Ltd"
                    disabled={linkToBankAccount}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="account_number">Account Number *</Label>
                  <Input
                    id="account_number"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="e.g., 1234567890"
                    disabled={linkToBankAccount}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="branch">Branch</Label>
                  <Input
                    id="branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="e.g., Westlands"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="swift_code">SWIFT Code</Label>
                  <Input
                    id="swift_code"
                    value={swiftCode}
                    onChange={(e) => setSwiftCode(e.target.value)}
                    placeholder="e.g., KCBLKENX"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="iban">IBAN</Label>
                  <Input
                    id="iban"
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    placeholder="Optional"
                  />
                </div>
              </div>
            </div>
          )}

          {type === "mobile_money" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={mobileProvider}
                  onValueChange={(v) => setMobileProvider(v as MobileMoneyDetails["provider"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MOBILE_MONEY_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="paybill">Paybill Number</Label>
                  <Input
                    id="paybill"
                    value={paybillNumber}
                    onChange={(e) => setPaybillNumber(e.target.value)}
                    placeholder="e.g., 123456"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="till">Till Number</Label>
                  <Input
                    id="till"
                    value={tillNumber}
                    onChange={(e) => setTillNumber(e.target.value)}
                    placeholder="e.g., 654321"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="mobile_account">Account Number</Label>
                  <Input
                    id="mobile_account"
                    value={mobileAccountNumber}
                    onChange={(e) => setMobileAccountNumber(e.target.value)}
                    placeholder="e.g., Company Name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="e.g., +254700000000"
                  />
                </div>
              </div>
            </div>
          )}

          {type === "online" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={onlineProvider}
                  onValueChange={(v) => setOnlineProvider(v as OnlinePaymentDetails["provider"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ONLINE_PAYMENT_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="online_email">Email</Label>
                  <Input
                    id="online_email"
                    type="email"
                    value={onlineEmail}
                    onChange={(e) => setOnlineEmail(e.target.value)}
                    placeholder="payments@company.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="online_username">Username</Label>
                  <Input
                    id="online_username"
                    value={onlineUsername}
                    onChange={(e) => setOnlineUsername(e.target.value)}
                    placeholder="@yourhandle"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payment_link">Payment Link</Label>
                <Input
                  id="payment_link"
                  type="url"
                  value={paymentLink}
                  onChange={(e) => setPaymentLink(e.target.value)}
                  placeholder="https://paypal.me/yourcompany"
                />
              </div>
            </div>
          )}

          {type === "cash" && (
            <div className="space-y-2">
              <Label htmlFor="cash_instructions">Payment Instructions</Label>
              <Textarea
                id="cash_instructions"
                value={cashInstructions}
                onChange={(e) => setCashInstructions(e.target.value)}
                placeholder="Enter instructions for cash payments..."
                rows={3}
              />
            </div>
          )}

          {type === "crypto" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Currency</Label>
                <Select
                  value={cryptoCurrency}
                  onValueChange={(v) => setCryptoCurrency(v as CryptoPaymentDetails["currency"])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRYPTO_CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wallet_address">Wallet Address *</Label>
                <Input
                  id="wallet_address"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="Enter wallet address"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="crypto_network">Network</Label>
                <Input
                  id="crypto_network"
                  value={cryptoNetwork}
                  onChange={(e) => setCryptoNetwork(e.target.value)}
                  placeholder="e.g., Ethereum Mainnet, BNB Chain"
                />
              </div>
            </div>
          )}

          {/* Options */}
          <div className="space-y-4 pt-4 border-t">
            <div className="flex items-center justify-between">
              <div>
                <Label>Set as default payment method</Label>
                <p className="text-xs text-muted-foreground">
                  Mark this as your primary payment method
                </p>
              </div>
              <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            </div>

            {(type === "mobile_money" || type === "crypto") && (
              <div className="flex items-center justify-between">
                <div>
                  <Label>Generate QR Code on documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Display a scannable QR code for easy payment
                  </p>
                </div>
                <Switch checked={qrCodeEnabled} onCheckedChange={setQrCodeEnabled} />
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving || !label.trim()}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEditing ? "Save Changes" : "Add Payment Method"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
