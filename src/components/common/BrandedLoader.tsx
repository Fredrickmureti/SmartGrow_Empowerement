import { motion } from "framer-motion";

interface BrandedLoaderProps {
  message?: string;
  fullScreen?: boolean;
}

export function BrandedLoader({ message = "Loading...", fullScreen = true }: BrandedLoaderProps) {
  const containerClass = fullScreen 
    ? "fixed inset-0 z-50 flex flex-col items-center justify-center bg-background"
    : "flex flex-col items-center justify-center py-16";

  return (
    <div className={containerClass}>
      {/* Logo Animation */}
      <div className="relative">
        {/* Outer rotating ring */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #3b82f6 100%)",
            padding: "3px",
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        >
          <div className="w-full h-full rounded-full bg-background" />
        </motion.div>

        {/* Logo container */}
        <motion.div
          className="relative w-20 h-20 rounded-2xl flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
          }}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          {/* Letter A */}
          <svg viewBox="0 0 32 32" className="w-12 h-12">
            <path
              d="M16 4 L8 26 L11 26 L12.5 22 L19.5 22 L21 26 L24 26 L16 4 Z M13.5 19 L16 11 L18.5 19 L13.5 19 Z"
              fill="white"
            />
            <motion.path
              d="M7 28 L25 28"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity={0.7}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1, delay: 0.5, ease: "easeInOut" }}
            />
          </svg>
        </motion.div>

        {/* Pulsing glow effect */}
        <motion.div
          className="absolute inset-0 rounded-2xl"
          style={{
            background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
            filter: "blur(20px)",
            opacity: 0.4,
          }}
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.4, 0.2, 0.4]
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* Brand name */}
      <motion.div
        className="mt-8 flex items-center gap-1"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        <span className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">
          Accrual
        </span>
        <span className="text-2xl font-bold text-foreground">
          Flow
        </span>
      </motion.div>

      {/* Loading message */}
      <motion.p
        className="mt-4 text-sm text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.5 }}
      >
        {message}
      </motion.p>

      {/* Animated dots */}
      <div className="mt-6 flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-2 h-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-500"
            animate={{
              y: [0, -8, 0],
              opacity: [0.5, 1, 0.5],
            }}
            transition={{
              duration: 0.8,
              repeat: Infinity,
              delay: i * 0.15,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
    </div>
  );
}
