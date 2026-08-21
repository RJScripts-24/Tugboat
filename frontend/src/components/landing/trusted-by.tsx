import {
  AwsWordmark,
  RazorpayWordmark,
  RupayWordmark,
  TwilioWordmark,
  UpiWordmark,
  WhatsAppBusinessWordmark,
} from "./brand-marks";
import { Reveal } from "./reveal";

const MARKS = [
  RazorpayWordmark,
  UpiWordmark,
  RupayWordmark,
  WhatsAppBusinessWordmark,
  TwilioWordmark,
  AwsWordmark,
];

export function TrustedBy() {
  return (
    <section className="relative bg-[#050e19] pb-12 lg:pb-[18px]">
      <div className="shell">
        <Reveal>
          <p className="text-center text-[20px] text-[#8b96a6]">
            Trusted by forward-thinking merchants
          </p>
        </Reveal>
        <Reveal delay={110}>
        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-8 lg:mt-[30px] lg:gap-x-[48px]">
          {MARKS.map((Mark, i) => (
            <li key={i} className="text-[#9aa4b2] opacity-80 transition-opacity hover:opacity-100">
              <Mark />
            </li>
          ))}
        </ul>
        </Reveal>
      </div>
    </section>
  );
}
