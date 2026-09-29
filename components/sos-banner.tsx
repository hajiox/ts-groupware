'use client'
import { usePathname } from 'next/navigation'
import { SosPanel } from './sos-panel'
export function SosBanner(){const path=usePathname();return path==='/sos'||path.startsWith('/time-clock')||path.startsWith('/login')?null:<SosPanel/>}
