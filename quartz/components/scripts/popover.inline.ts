import { computePosition, flip, offset, shift } from "@floating-ui/dom"
import { normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

// Simple data model with direct references to DOM elements
interface PopoverInfo {
    element: HTMLElement        // The popover element
    link: HTMLAnchorElement     // The link that created this popover
    parent: HTMLElement | null  // Parent popover (if any)
    connector: HTMLElement | null // Visual connector
    level: number               // Nesting level
}

// Global state using WeakMaps to avoid memory leaks
const popoverData = new WeakMap<HTMLElement, PopoverInfo>()
const linkToPopover = new WeakMap<HTMLAnchorElement, HTMLElement>()
const childPopovers = new WeakMap<HTMLElement, Set<HTMLElement>>()
const HIDE_DELAY = 200 // ms - reduced delay for faster response
let initialized = false

// Top-level state
const activePopovers = new Set<HTMLElement>() // Track all currently visible popovers
let hoverTimeout: number | null = null
let lastMousePosition = { x: 0, y: 0 }

/**
 * Initialize the popover system
 */
function initializePopovers() {
    if (initialized) return
    initialized = true

    // Use event delegation for all mouse events
    document.addEventListener("mouseover", handleMouseOver)
    document.addEventListener("mouseout", handleMouseOut)
    document.addEventListener("mousemove", trackMousePosition)

    // Listen for ESC key to close all popovers
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeAllPopovers()
        }
    })

    // Clean up on page unload
    window.addCleanup(() => {
        document.removeEventListener("mouseover", handleMouseOver)
        document.removeEventListener("mouseout", handleMouseOut)
        document.removeEventListener("mousemove", trackMousePosition)
        initialized = false
    })

    // Track scroll to update popover positions
    window.addEventListener("scroll", handleScroll, { passive: true })
    window.addCleanup(() => {
        window.removeEventListener("scroll", handleScroll)
    })

    // Start the global hover check timer
    startGlobalHoverCheck()
}

/**
 * Track mouse position for accurate hover detection
 */
function trackMousePosition(e: MouseEvent) {
    lastMousePosition.x = e.clientX
    lastMousePosition.y = e.clientY
}

/**
 * Start a global timer to periodically check hover states
 * This ensures popovers disappear even if events are missed
 */
function startGlobalHoverCheck() {
    if (hoverTimeout) {
        clearInterval(hoverTimeout)
    }

    hoverTimeout = window.setInterval(() => {
        const { x, y } = lastMousePosition

        // Get the element under the current mouse position
        const elementAtPoint = document.elementFromPoint(x, y)
        if (!elementAtPoint) return

        // Check all popovers to see if they should be visible
        for (const popover of activePopovers) {
            // Skip if mouse is over this popover or related elements
            if (isMouseOverOrRelated(popover, elementAtPoint)) {
                continue
            }

            // Force hide the popover
            hidePopoverAndChildren(popover)
        }
    }, 1000) // Check every second

    window.addCleanup(() => {
        if (hoverTimeout) {
            clearInterval(hoverTimeout)
            hoverTimeout = null
        }
    })
}

/**
 * Close all popovers immediately
 */
function closeAllPopovers() {
    for (const popover of activePopovers) {
        hidePopoverImmediately(popover)
    }
    activePopovers.clear()
}

/**
 * Check if mouse is over a popover or related elements
 */
function isMouseOverOrRelated(popover: HTMLElement, elementAtPoint: Element | null): boolean {
    if (!elementAtPoint) return false

    // Check if mouse is over this popover
    if (popover.contains(elementAtPoint)) {
        return true
    }

    // Check if mouse is over the link that created this popover
    const info = popoverData.get(popover)
    if (info && info.link && info.link.contains(elementAtPoint)) {
        return true
    }

    // Check if mouse is over a child popover
    const children = childPopovers.get(popover)
    if (children) {
        for (const child of children) {
            if (isMouseOverOrRelated(child, elementAtPoint)) {
                return true
            }
        }
    }

    return false
}

/**
 * Create a new popover for a link
 */
async function createPopover(link: HTMLAnchorElement, event: MouseEvent) {
    // Check if we already created a popover for this link
    if (linkToPopover.has(link)) {
        const popover = linkToPopover.get(link)!
        showPopover(popover)
        return
    }

    // Find parent popover if this link is inside another popover
    let parentPopover: HTMLElement | null = null
    let level = 0
    let currentElement: HTMLElement | null = link.parentElement

    while (currentElement) {
        if (currentElement.classList.contains('popover')) {
            parentPopover = currentElement
            const info = popoverData.get(parentPopover)
            if (info) {
                level = info.level + 1
            }
            break
        }
        currentElement = currentElement.parentElement
    }

    // Fetch content for the popover
    const targetUrl = new URL(link.href)
    const hash = decodeURIComponent(targetUrl.hash)
    const fetchUrl = new URL(targetUrl)
    fetchUrl.hash = ""
    fetchUrl.search = ""

    try {
        // Start fetching content
        const response = await fetchCanonical(fetchUrl)

        // Check if we're still interested in showing this popover
        if (!isHovering(link) || linkToPopover.has(link)) {
            return
        }

        // Create the popover element
        const popover = document.createElement("div")
        popover.classList.add("popover")
        popover.setAttribute("data-popover-id", Math.random().toString(36).substring(2, 9))
        popover.dataset.source = link.href.split('#')[0] // Store source for debugging

        const inner = document.createElement("div")
        inner.classList.add("popover-inner")
        popover.appendChild(inner)

        // Process content based on type
        const contentType = response.headers.get("Content-Type") || ""
        const [contentTypeCategory, typeInfo] = contentType.split(";")[0].split("/")
        inner.dataset.contentType = contentType

        switch (contentTypeCategory) {
            case "image":
                const img = document.createElement("img")
                img.src = targetUrl.toString()
                img.alt = targetUrl.pathname
                inner.appendChild(img)
                break

            case "application":
                if (typeInfo === "pdf") {
                    const iframe = document.createElement("iframe")
                    iframe.src = targetUrl.toString()
                    inner.appendChild(iframe)
                }
                break

            default:
                // Parse HTML content
                const text = await response.text()
                const html = new DOMParser().parseFromString(text, "text/html")
                normalizeRelativeURLs(html, new URL(window.location.href))

                // Extract popover hint elements
                const hints = [...html.getElementsByClassName("popover-hint")]
                if (hints.length === 0) return

                hints.forEach(hint => {
                    const clone = document.importNode(hint, true)
                    inner.appendChild(clone)
                })

                if (!inner.firstChild) return
        }

        // Create connector for nested popovers
        let connector: HTMLElement | null = null
        if (level > 0) {
            connector = document.createElement("div")
            connector.classList.add("popover-connector")
            connector.style.opacity = "0"
            document.body.appendChild(connector)
        }

        // Store relationship data
        const info: PopoverInfo = {
            element: popover,
            link,
            parent: parentPopover,
            connector,
            level
        }

        popoverData.set(popover, info)
        linkToPopover.set(link, popover)

        // Add to parent's children set
        if (parentPopover) {
            let children = childPopovers.get(parentPopover)
            if (!children) {
                children = new Set()
                childPopovers.set(parentPopover, children)
            }
            children.add(popover)
        }

        // Add custom hover class for debugging
        popover.dataset.hoverState = "init"

        // Add to DOM and position
        document.body.appendChild(popover)
        positionPopover(popover)

        // If there's a hash fragment, scroll to it
        if (hash) {
            const heading = inner.querySelector(hash) as HTMLElement | null
            if (heading) {
                inner.scroll({ top: heading.offsetTop - 12, behavior: "instant" })
            }
        }

        // Ensure we actually show it
        if (isHovering(link)) {
            showPopover(popover)
        }

    } catch (error) {
        console.error("Error creating popover:", error)
    }
}

/**
 * Position a popover relative to its source link
 */
async function positionPopover(popover: HTMLElement) {
    const info = popoverData.get(popover)
    if (!info) return

    const { link, level, connector } = info
    const isRoot = level === 0

    // Get link dimensions and position
    const linkRect = link.getBoundingClientRect()

    // Determine placement strategy based on level and available space
    let placement: 'bottom-start' | 'top-start' | 'right-start' | 'left-start'

    // Default placement: first level popovers appear below the link,
    // nested popovers appear to the right of the link
    if (isRoot) {
        // Check if there's room below, otherwise place above
        const viewportHeight = window.innerHeight
        const spaceBelow = viewportHeight - linkRect.bottom

        placement = spaceBelow > 250 ? 'bottom-start' : 'top-start'
    } else {
        // For nested popovers, check if there's room to the right
        const viewportWidth = window.innerWidth
        const spaceRight = viewportWidth - linkRect.right

        placement = spaceRight > 300 ? 'right-start' : 'left-start'
    }

    // Apply middleware for positioning adjustments
    const middleware = [
        offset(isRoot ? 5 : 10), // Less offset for root popovers
        shift({ padding: 20 }), // Keep on screen with more padding
        flip({ // More intelligent flipping
            fallbackPlacements: ['top-start', 'right-start', 'left-start', 'bottom-start'],
            padding: 20
        })
    ]

    // Calculate position
    const { x, y } = await computePosition(link, popover, {
        placement,
        middleware
    })

    // Get scroll offsets to ensure proper absolute positioning
    const scrollX = window.scrollX
    const scrollY = window.scrollY

    // Apply position and stacking
    const zIndex = 1000 + level
    Object.assign(popover.style, {
        left: `${x}px`,
        top: `${y}px`,
        zIndex: zIndex.toString()
    })

    // Store the computed position for debugging
    popover.dataset.computedPosition = `x:${x}, y:${y}, placement:${placement}`

    // Position connector if needed
    if (connector) {
        // Get popover position after positioning
        const popoverRect = popover.getBoundingClientRect()

        // Determine connector points based on relative positions
        let sourceX, sourceY, targetX, targetY

        if (placement.startsWith('right')) {
            // Link is to the left of popover
            sourceX = linkRect.right
            sourceY = linkRect.top + 20
            targetX = popoverRect.left
            targetY = popoverRect.top + 20
        } else if (placement.startsWith('left')) {
            // Link is to the right of popover
            sourceX = linkRect.left
            sourceY = linkRect.top + 20
            targetX = popoverRect.right
            targetY = popoverRect.top + 20
        } else if (placement.startsWith('bottom')) {
            // Link is above popover
            sourceX = linkRect.left + 20
            sourceY = linkRect.bottom
            targetX = popoverRect.left + 20
            targetY = popoverRect.top
        } else {
            // Link is below popover (top placement)
            sourceX = linkRect.left + 20
            sourceY = linkRect.top
            targetX = popoverRect.left + 20
            targetY = popoverRect.bottom
        }

        // Draw horizontal connector
        if (placement.startsWith('right') || placement.startsWith('left')) {
            connector.style.left = `${Math.min(sourceX, targetX)}px`
            connector.style.top = `${sourceY}px`
            connector.style.width = `${Math.abs(targetX - sourceX)}px`
            connector.style.height = '1px'
        } else {
            // Draw vertical connector
            connector.style.left = `${sourceX}px`
            connector.style.top = `${Math.min(sourceY, targetY)}px`
            connector.style.width = '1px'
            connector.style.height = `${Math.abs(targetY - sourceY)}px`
        }

        connector.style.zIndex = (zIndex - 1).toString()
    }

    // After positioning, make sure we fit on screen by checking bounds
    ensureOnScreen(popover)
}

/**
 * Show a popover and its connector
 */
function showPopover(popover: HTMLElement) {
    if (popover.classList.contains('visible')) return

    // Add to active popovers set
    activePopovers.add(popover)

    // Mark as visible
    popover.classList.add('visible')
    popover.dataset.hoverState = "visible"

    // Clear any hide timeout
    clearTimeout(parseInt(popover.dataset.hideTimeout || "0"))
    delete popover.dataset.hideTimeout

    // Show connector if any
    const info = popoverData.get(popover)
    if (info?.connector) {
        info.connector.style.opacity = "1"
    }
}

/**
 * Schedule hiding a popover after a delay
 */
function scheduleHidePopover(popover: HTMLElement) {
    // Skip if already has a hide timeout
    if (popover.dataset.hideTimeout) return

    // Set timeout to hide
    const timeoutId = window.setTimeout(() => {
        // Final check if we should still hide
        if (isHovering(popover) || isAnyChildHovering(popover)) {
            return
        }

        const info = popoverData.get(popover)
        if (!info) return

        // If the source link is being hovered, don't hide
        if (isHovering(info.link)) {
            return
        }

        hidePopoverAndChildren(popover)
    }, HIDE_DELAY)

    popover.dataset.hideTimeout = timeoutId.toString()
}

/**
 * Hide a popover and all its children
 */
function hidePopoverAndChildren(popover: HTMLElement) {
    popover.dataset.hoverState = "hiding"

    // Hide all children first
    const children = childPopovers.get(popover)
    if (children) {
        for (const child of children) {
            // Don't hide if the child or its link is being hovered
            const childInfo = popoverData.get(child)
            if (childInfo && (isHovering(child) || isHovering(childInfo.link))) {
                continue
            }

            hidePopoverAndChildren(child)
        }
    }

    // Finally hide this popover
    hidePopoverImmediately(popover)
}

/**
 * Immediately hide a popover without checks
 */
function hidePopoverImmediately(popover: HTMLElement) {
    // Remove from active popovers
    activePopovers.delete(popover)

    // Hide connector
    const info = popoverData.get(popover)
    if (info?.connector) {
        info.connector.style.opacity = "0"
    }

    // Hide this popover
    popover.classList.remove('visible')
}

/**
 * Check if any child of a popover is being hovered
 */
function isAnyChildHovering(popover: HTMLElement): boolean {
    const children = childPopovers.get(popover)
    if (!children) return false

    for (const child of children) {
        // If this child is being hovered
        if (isHovering(child)) return true

        // If the link that created this child is being hovered
        const childInfo = popoverData.get(child)
        if (childInfo && isHovering(childInfo.link)) return true

        // Check grandchildren recursively
        if (isAnyChildHovering(child)) return true
    }

    return false
}

/**
 * Check if an element is currently being hovered
 */
function isHovering(element: HTMLElement): boolean {
    return element.dataset.isHovered === "true"
}

/**
 * Set hover state for an element
 */
function setHovering(element: HTMLElement, hovering: boolean) {
    element.dataset.isHovered = hovering ? "true" : "false"
}

/**
 * Handle global mouse over events
 */
function handleMouseOver(event: MouseEvent) {
    const target = event.target as HTMLElement
    if (!target) return

    // Find if we're hovering a link or popover
    let link: HTMLAnchorElement | null = null
    let popover: HTMLElement | null = null
    let current: HTMLElement | null = target

    while (current && current !== document.body) {
        // Track if we're over a popover
        if (current.classList.contains('popover')) {
            popover = current
            setHovering(popover, true)

            // Show the popover
            showPopover(popover)

            // If we found a popover, no need to check if it contains a link
            break
        }

        // Track if we're over a link that should trigger a popover
        if (current.tagName === 'A' && current.classList.contains('internal') && current.dataset.noPopover !== "true") {
            link = current as HTMLAnchorElement
            setHovering(link, true)

            // Create/show popover for this link
            createPopover(link, event)
            break
        }

        current = current.parentElement
    }
}

/**
 * Handle global mouse out events
 */
function handleMouseOut(event: MouseEvent) {
    const target = event.target as HTMLElement
    const relatedTarget = event.relatedTarget as HTMLElement
    if (!target) return

    // Handle popover hovers
    let current: HTMLElement | null = target

    while (current && current !== document.body) {
        // Handle popovers
        if (current.classList.contains('popover')) {
            const popover = current

            // Check if we're moving to a related element
            if (isMovingToRelated(popover, relatedTarget)) {
                return
            }

            setHovering(popover, false)
            scheduleHidePopover(popover)
            break
        }

        // Handle links
        if (current.tagName === 'A' && current.classList.contains('internal')) {
            const link = current as HTMLAnchorElement

            // Check if we're moving to this link's popover
            const linkPopover = linkToPopover.get(link)
            if (linkPopover && isMovingToRelated(link, relatedTarget)) {
                return
            }

            setHovering(link, false)

            // Schedule hiding this link's popover
            if (linkPopover) {
                scheduleHidePopover(linkPopover)
            }

            break
        }

        current = current.parentElement
    }
}

/**
 * Check if we're moving from one element to a related element
 */
function isMovingToRelated(source: HTMLElement, target: HTMLElement | null): boolean {
    if (!target) return false

    // Moving to self
    if (source === target) return true

    // Moving to a child
    if (source.contains(target)) return true

    // If this is a popover, check if moving to its link
    if (source.classList.contains('popover')) {
        const info = popoverData.get(source)
        if (info && info.link && (info.link === target || info.link.contains(target))) {
            return true
        }
    }

    // If source is a popover, check if moving to parent popover
    if (source.classList.contains('popover')) {
        const info = popoverData.get(source)
        if (info && info.parent) {
            if (info.parent === target || info.parent.contains(target)) {
                return true
            }
        }
    }

    // If source is a link, check if moving to its popover
    if (source.tagName === 'A' && source.classList.contains('internal')) {
        const popover = linkToPopover.get(source as HTMLAnchorElement)
        if (popover && (popover === target || popover.contains(target))) {
            return true
        }
    }

    return false
}

/**
 * Handle scroll events to reposition popovers
 */
function handleScroll() {
    // Debounce scroll handling
    if (handleScroll.timeout) {
        clearTimeout(handleScroll.timeout)
    }

    handleScroll.timeout = setTimeout(() => {
        document.querySelectorAll('.popover.visible').forEach(popover => {
            positionPopover(popover as HTMLElement)
        })
    }, 50)
}
// Add the timeout property to the handleScroll function
handleScroll.timeout = null as ReturnType<typeof setTimeout> | null

// Initialize the popover system when navigation happens
document.addEventListener("nav", () => {
    initializePopovers()
})

/**
 * Make sure popover is fully visible on screen
 */
function ensureOnScreen(popover: HTMLElement) {
    // Get popover dimensions
    const rect = popover.getBoundingClientRect()

    // Get viewport dimensions
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    // Check if popover is partially offscreen
    let offsetX = 0
    let offsetY = 0

    // Check right edge
    if (rect.right > viewportWidth - 20) {
        offsetX = viewportWidth - 20 - rect.right
    }

    // Check left edge
    if (rect.left < 20) {
        offsetX = 20 - rect.left
    }

    // Check bottom edge
    if (rect.bottom > viewportHeight - 20) {
        offsetY = viewportHeight - 20 - rect.bottom
    }

    // Check top edge
    if (rect.top < 20) {
        offsetY = 20 - rect.top
    }

    // Apply offset if needed
    if (offsetX !== 0 || offsetY !== 0) {
        const currentLeft = parseInt(popover.style.left) || 0
        const currentTop = parseInt(popover.style.top) || 0

        popover.style.left = `${currentLeft + offsetX}px`
        popover.style.top = `${currentTop + offsetY}px`

        // Also update the connector if it exists
        const info = popoverData.get(popover)
        if (info?.connector) {
            // Reposition connector based on new position
            setTimeout(() => {
                const newRect = popover.getBoundingClientRect()
                const linkRect = info.link.getBoundingClientRect()

                // Simple connector positioning as a fallback
                let connectorLeft, connectorTop, connectorWidth, connectorHeight

                if (newRect.left > linkRect.right) {
                    // Popover is to the right of link
                    connectorLeft = linkRect.right
                    connectorTop = linkRect.top + 20
                    connectorWidth = newRect.left - linkRect.right
                    connectorHeight = 1
                } else if (newRect.right < linkRect.left) {
                    // Popover is to the left of link
                    connectorLeft = newRect.right
                    connectorTop = linkRect.top + 20
                    connectorWidth = linkRect.left - newRect.right
                    connectorHeight = 1
                } else if (newRect.top > linkRect.bottom) {
                    // Popover is below link
                    connectorLeft = linkRect.left + 20
                    connectorTop = linkRect.bottom
                    connectorWidth = 1
                    connectorHeight = newRect.top - linkRect.bottom
                } else {
                    // Popover is above link
                    connectorLeft = linkRect.left + 20
                    connectorTop = newRect.bottom
                    connectorWidth = 1
                    connectorHeight = linkRect.top - newRect.bottom
                }

                const connector = info.connector
                if (connector) {
                    connector.style.left = `${connectorLeft}px`
                    connector.style.top = `${connectorTop}px`
                    connector.style.width = `${connectorWidth}px`
                    connector.style.height = `${connectorHeight}px`
                }
            }, 10)
        }
    }
}
